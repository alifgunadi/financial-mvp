interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export type { UploadedFile };
