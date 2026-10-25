export const GOOGLE_DRIVE_SCOPE =
  "https://www.googleapis.com/auth/drive.appdata";
export const GOOGLE_DRIVE_FILENAME = "stitch-embroidery-project.json";

type DriveFile = {
  id: string;
  name: string;
  modifiedTime?: string;
};

type DriveFileList = {
  files?: DriveFile[];
};

export class GoogleDriveError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "GoogleDriveError";
    this.status = status;
  }
}

async function driveRequest(
  url: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    let details = "";
    try {
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      details = payload.error?.message ?? "";
    } catch {
      details = await response.text().catch(() => "");
    }
    throw new GoogleDriveError(
      details || `Google Drive вернул ошибку ${response.status}.`,
      response.status,
    );
  }

  return response;
}

export async function findCloudProject(accessToken: string) {
  const query = encodeURIComponent(
    `name='${GOOGLE_DRIVE_FILENAME}' and trashed=false`,
  );
  const fields = encodeURIComponent("files(id,name,modifiedTime)");
  const response = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&orderBy=modifiedTime%20desc&fields=${fields}`,
    accessToken,
  );
  const payload = (await response.json()) as DriveFileList;
  return payload.files?.[0] ?? null;
}

export async function downloadCloudProject(
  accessToken: string,
  fileId: string,
) {
  const response = await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    accessToken,
  );
  return response.text();
}

export async function uploadCloudProject(
  accessToken: string,
  json: string,
) {
  const existing = await findCloudProject(accessToken);

  if (existing) {
    const response = await driveRequest(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=media&fields=id,name,modifiedTime`,
      accessToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: json,
      },
    );
    return (await response.json()) as DriveFile;
  }

  const boundary = `stitch_${crypto.randomUUID().replaceAll("-", "")}`;
  const metadata = JSON.stringify({
    name: GOOGLE_DRIVE_FILENAME,
    parents: ["appDataFolder"],
  });
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    json,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const response = await driveRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime",
    accessToken,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  return (await response.json()) as DriveFile;
}
