export function nodeImagePath(nodeId: string): string {
  return `/api/image/${encodeURIComponent(nodeId)}`;
}

const SAFE_IMAGE_MEDIA = new Map<string, { contentType: string; extension: string }>([
  ["image/png", { contentType: "image/png", extension: "png" }],
  ["image/jpeg", { contentType: "image/jpeg", extension: "jpg" }],
  ["image/jpg", { contentType: "image/jpeg", extension: "jpg" }],
  ["image/webp", { contentType: "image/webp", extension: "webp" }],
  ["image/gif", { contentType: "image/gif", extension: "gif" }],
  ["image/avif", { contentType: "image/avif", extension: "avif" }],
]);

export function safeStoredImageMedia(
  value: string,
): { contentType: string; extension: string } | null {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SAFE_IMAGE_MEDIA.get(normalized) ?? null;
}
