import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getS3Client, OSS_BUCKET, OSS_ENDPOINT } from "../oss.js";

export interface AttachmentsRepoDeps {
  s3Client?: S3Client;
}

export function makeAttachmentsRepo(deps?: AttachmentsRepoDeps) {
  const s3 = deps?.s3Client ?? getS3Client();

  function resolveKey(path: string, bucket?: string) {
    const ns = bucket || "attachments";
    return `attachments/${ns}/${path}`;
  }

  return {
    async uploadAttachment({
      path,
      mime,
      bytes,
      bucket,
    }: {
      path: string;
      mime: string;
      bytes: Buffer | Uint8Array;
      bucket?: string;
    }): Promise<{ path: string; url: string }> {
      const key = resolveKey(path, bucket);
      const ossBucket = OSS_BUCKET();
      await s3.send(
        new PutObjectCommand({
          Bucket: ossBucket,
          Key: key,
          Body: bytes,
          ContentType: mime,
        })
      );
      const url = `${OSS_ENDPOINT()}/${ossBucket}/${key}`;
      return { path, url };
    },

    async downloadAttachment(
      path: string,
      { bucket }: { bucket?: string } = {}
    ): Promise<{ mime: string; bytes: Buffer } | null> {
      const key = resolveKey(path, bucket);
      const ossBucket = OSS_BUCKET();
      try {
        const res = await s3.send(
          new GetObjectCommand({ Bucket: ossBucket, Key: key })
        );
        if (!res.Body) return null;
        const arr = await res.Body.transformToByteArray();
        const bytes = Buffer.from(arr);
        const mime = res.ContentType ?? "application/octet-stream";
        return { mime, bytes };
      } catch (err: unknown) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (
          e.name === "NoSuchKey" ||
          e.$metadata?.httpStatusCode === 404
        ) {
          return null;
        }
        throw err;
      }
    },
  };
}
