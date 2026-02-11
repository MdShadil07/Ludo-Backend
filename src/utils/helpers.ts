export function generateRoomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export function formatErrorResponse(message: string, details?: string) {
  return {
    success: false,
    error: message,
    details: details || undefined,
  };
}

export function formatSuccessResponse(data: any, message?: string) {
  return {
    success: true,
    data,
    message: message || undefined,
  };
}
