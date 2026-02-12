import { Request, Response } from "express";
import path from "path";
import { User } from "../models/User";
import { formatErrorResponse, formatSuccessResponse } from "../utils/helpers";

type UpdateProfileBody = {
  displayName?: string;
  avatarBase64?: string;
  avatarMimeType?: string;
  avatarFileName?: string;
};

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function logSupabaseProfileStorageStatus(): Promise<void> {
  const { supabaseUrl, serviceRoleKey, bucket } = getSupabaseConfig();
  if (!supabaseUrl || !serviceRoleKey) {
    console.warn(
      `[profile][supabase] disabled - missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (bucket=${bucket})`
    );
    return;
  }

  try {
    const checkUrl = `${supabaseUrl}/storage/v1/bucket/${bucket}`;
    const response = await fetch(checkUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    });

    if (response.ok) {
      console.log(
        `[profile][supabase] connected - bucket "${bucket}" is reachable (url=${supabaseUrl})`
      );
      return;
    }

    const details = await response.text();
    console.warn(
      `[profile][supabase] not connected - bucket check failed (status=${response.status}) bucket="${bucket}" url=${supabaseUrl} details=${details}`
    );
  } catch (error) {
    console.warn(
      `[profile][supabase] not connected - request error for bucket "${bucket}"`,
      error
    );
  }
}

const getSupabaseConfig = () => ({
  supabaseUrl: process.env.SUPABASE_URL?.trim() || "",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
  bucket: process.env.SUPABASE_AVATAR_BUCKET?.trim() || "uploads",
});

const profileShape = (user: any) => ({
  userId: user._id,
  email: user.email,
  displayName: user.displayName,
  avatarUrl: user.avatarUrl,
  xp: user.xp,
  level: user.level,
  gamesPlayed: user.gamesPlayed,
  wins: user.wins,
});

const ensureSupabaseConfig = () => {
  const { supabaseUrl, serviceRoleKey, bucket } = getSupabaseConfig();
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_NOT_CONFIGURED");
  }
  return { supabaseUrl, serviceRoleKey, bucket };
};

const extractObjectPathFromPublicUrl = (avatarUrl?: string): string | null => {
  const { supabaseUrl, bucket } = getSupabaseConfig();
  if (!avatarUrl || !supabaseUrl) return null;
  const publicPrefix = `${supabaseUrl}/storage/v1/object/public/${bucket}/`;
  if (!avatarUrl.startsWith(publicPrefix)) return null;
  return decodeURIComponent(avatarUrl.slice(publicPrefix.length));
};

const uploadAvatar = async (objectPath: string, buffer: Buffer, mimeType: string): Promise<string> => {
  const { supabaseUrl, serviceRoleKey, bucket } = ensureSupabaseConfig();
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${encodeURIComponent(objectPath)}`;
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": mimeType,
      "x-upsert": "true",
    },
    body: buffer,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SUPABASE_UPLOAD_FAILED:${response.status}:${text}`);
  }

  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${encodeURIComponent(objectPath)}`;
};

const deleteAvatarObject = async (objectPath: string): Promise<void> => {
  const { supabaseUrl, serviceRoleKey, bucket } = ensureSupabaseConfig();
  const deleteUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${encodeURIComponent(objectPath)}`;
  const response = await fetch(deleteUrl, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  });

  if (response.ok || response.status === 404) return;
  const text = await response.text();
  throw new Error(`SUPABASE_DELETE_FAILED:${response.status}:${text}`);
};

export async function getMyProfile(req: Request, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const user = await User.findById(userId).select("-password");
    if (!user) return res.status(404).json(formatErrorResponse("User not found"));

    return res.json(formatSuccessResponse(profileShape(user)));
  } catch (error) {
    console.error("Get profile error:", error);
    return res.status(500).json(formatErrorResponse("Failed to fetch profile"));
  }
}

export async function updateMyProfile(req: Request, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const { displayName, avatarBase64, avatarMimeType, avatarFileName } = req.body as UpdateProfileBody;
    if (!displayName && !avatarBase64) {
      return res.status(400).json(formatErrorResponse("At least one field is required"));
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json(formatErrorResponse("User not found"));

    if (displayName !== undefined) {
      const trimmed = displayName.trim();
      if (trimmed.length < 2 || trimmed.length > 40) {
        return res.status(400).json(formatErrorResponse("displayName must be between 2 and 40 characters"));
      }
      user.displayName = trimmed;
    }

    if (avatarBase64) {
      ensureSupabaseConfig();
      const mimeType = (avatarMimeType || "image/jpeg").toLowerCase();
      if (!MIME_EXT[mimeType]) {
        return res.status(400).json(formatErrorResponse("Unsupported avatar file type"));
      }

      const base64Part = avatarBase64.includes(",") ? avatarBase64.split(",")[1] : avatarBase64;
      if (!base64Part) {
        return res.status(400).json(formatErrorResponse("Invalid avatar payload"));
      }

      const avatarBuffer = Buffer.from(base64Part, "base64");
      if (!avatarBuffer.length || avatarBuffer.length > MAX_AVATAR_BYTES) {
        return res.status(400).json(formatErrorResponse("Avatar must be between 1 byte and 5MB"));
      }

      const originalExt = avatarFileName ? path.extname(avatarFileName).replace(".", "").toLowerCase() : "";
      const extension = originalExt || MIME_EXT[mimeType];
      const objectPath = `${user._id.toString()}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

      const oldObjectPath = extractObjectPathFromPublicUrl(user.avatarUrl);
      const newAvatarUrl = await uploadAvatar(objectPath, avatarBuffer, mimeType);

      try {
        if (oldObjectPath && oldObjectPath !== objectPath) {
          await deleteAvatarObject(oldObjectPath);
        }
      } catch (cleanupError) {
        // Prevent orphaned files if old-avatar cleanup fails.
        try {
          await deleteAvatarObject(objectPath);
        } catch (_) {}
        throw cleanupError;
      }

      user.avatarUrl = newAvatarUrl;
    }

    await user.save();
    return res.json(formatSuccessResponse(profileShape(user), "Profile updated"));
  } catch (error: any) {
    if (error instanceof Error && error.message === "SUPABASE_NOT_CONFIGURED") {
      return res.status(500).json(formatErrorResponse("Supabase is not configured on server"));
    }
    console.error("Update profile error:", error);
    return res.status(500).json(formatErrorResponse("Failed to update profile"));
  }
}
