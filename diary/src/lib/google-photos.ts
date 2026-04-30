import { db } from "@/lib/db";
import { getValidGoogleToken } from "@/lib/google-auth";

const PHOTOS_BASE = "https://photoslibrary.googleapis.com/v1";

interface PhotosMediaItem {
  id: string;
  filename: string;
  mimeType: string;
  mediaMetadata?: {
    creationTime?: string;
    width?: string;
    height?: string;
    photo?: { cameraMake?: string };
    video?: { status?: string };
  };
  baseUrl?: string;
  productUrl?: string;
}

interface PhotosListResponse {
  mediaItems?: PhotosMediaItem[];
  nextPageToken?: string;
}

export async function syncGooglePhotos(connectionId: string): Promise<number> {
  const accessToken = await getValidGoogleToken(connectionId);

  let totalSynced = 0;
  let pageToken: string | undefined;

  do {
    const body: Record<string, unknown> = { pageSize: 100 };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(`${PHOTOS_BASE}/mediaItems:search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Google Photos API error: ${await res.text()}`);

    const data: PhotosListResponse = await res.json();
    pageToken = data.nextPageToken;

    for (const item of data.mediaItems ?? []) {
      const takenAt = item.mediaMetadata?.creationTime
        ? new Date(item.mediaMetadata.creationTime)
        : null;

      await db.mediaItem.upsert({
        where: { externalId_source: { externalId: item.id, source: "google_photos" } },
        create: {
          externalId: item.id,
          source: "google_photos",
          filename: item.filename,
          mimeType: item.mimeType,
          takenAt,
          thumbnailUrl: item.baseUrl ? `${item.baseUrl}=w400-h400` : null,
          webUrl: item.productUrl,
          width: item.mediaMetadata?.width ? parseInt(item.mediaMetadata.width) : null,
          height: item.mediaMetadata?.height ? parseInt(item.mediaMetadata.height) : null,
        },
        update: {
          filename: item.filename,
          takenAt,
          thumbnailUrl: item.baseUrl ? `${item.baseUrl}=w400-h400` : null,
        },
      });
      totalSynced++;
    }
  } while (pageToken);

  return totalSynced;
}

export async function syncGoogleDrive(connectionId: string, folderIds: string[] = []): Promise<number> {
  const accessToken = await getValidGoogleToken(connectionId);

  let totalSynced = 0;
  let pageToken: string | undefined;

  const mimeFilter = "mimeType contains 'image/' or mimeType contains 'video/'";
  let query = mimeFilter;
  if (folderIds.length > 0) {
    const folderQuery = folderIds.map((id) => `'${id}' in parents`).join(" or ");
    query = `(${folderQuery}) and (${mimeFilter})`;
  }

  do {
    const params = new URLSearchParams({
      q: query,
      fields: "nextPageToken,files(id,name,mimeType,createdTime,thumbnailLink,webViewLink,imageMediaMetadata)",
      pageSize: "100",
      ...(pageToken ? { pageToken } : {}),
    });

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) throw new Error(`Google Drive API error: ${await res.text()}`);

    const data = await res.json();
    pageToken = data.nextPageToken;

    for (const file of data.files ?? []) {
      const takenAt = file.createdTime ? new Date(file.createdTime) : null;
      const lat = file.imageMediaMetadata?.location?.latitude ?? null;
      const lng = file.imageMediaMetadata?.location?.longitude ?? null;

      await db.mediaItem.upsert({
        where: { externalId_source: { externalId: file.id, source: "google_drive" } },
        create: {
          externalId: file.id,
          source: "google_drive",
          filename: file.name,
          mimeType: file.mimeType,
          takenAt,
          lat,
          lng,
          thumbnailUrl: file.thumbnailLink ?? null,
          webUrl: file.webViewLink ?? null,
          width: file.imageMediaMetadata?.width ?? null,
          height: file.imageMediaMetadata?.height ?? null,
        },
        update: {
          filename: file.name,
          takenAt,
          lat,
          lng,
          thumbnailUrl: file.thumbnailLink ?? null,
        },
      });

      // Auto-create location from EXIF GPS
      if (lat !== null && lng !== null && takenAt) {
        await db.location.upsert({
          where: {
            // We use a compound approach: check by source + approximate match via findFirst
            // For upsert we need unique field — store externalId in notes as fallback
            id: `drive_${file.id}`,
          },
          create: {
            id: `drive_${file.id}`,
            label: file.name,
            lat,
            lng,
            date: takenAt,
            type: "past",
            source: "exif",
            notes: `Google Drive: ${file.id}`,
          },
          update: { lat, lng, date: takenAt },
        });
      }

      totalSynced++;
    }
  } while (pageToken);

  return totalSynced;
}
