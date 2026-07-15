import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { S3Client } from "@aws-sdk/client-s3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { makeAttachmentsRepo } from "../src/lib/pg-repo/attachments.js";

// ---------------------------------------------------------------------------
// Mock S3 client
// ---------------------------------------------------------------------------
type MockStore = Map<string, { body: Uint8Array; contentType: string }>;

function makeMockS3Client(): { client: S3Client; store: MockStore } {
  const store: MockStore = new Map();

  const client = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutObjectCommand) {
        const input = command.input;
        const key = `${input.Bucket}::${input.Key}`;
        let body: Uint8Array;
        if (input.Body instanceof Uint8Array) {
          body = input.Body;
        } else if (Buffer.isBuffer(input.Body)) {
          body = new Uint8Array(input.Body);
        } else {
          throw new Error("mock: unsupported body type");
        }
        store.set(key, {
          body,
          contentType: input.ContentType ?? "application/octet-stream",
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const input = command.input;
        const key = `${input.Bucket}::${input.Key}`;
        const entry = store.get(key);
        if (!entry) {
          const err = Object.assign(new Error("NoSuchKey"), {
            name: "NoSuchKey",
          });
          throw err;
        }
        const storedBody = entry.body;
        return {
          ContentType: entry.contentType,
          Body: {
            transformToByteArray: async () => storedBody,
          },
        };
      }
      throw new Error(`mock: unknown command ${(command as object).constructor.name}`);
    },
  } as unknown as S3Client;

  return { client, store };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("makeAttachmentsRepo (mock S3)", () => {
  it("upload returns {path, url:string}", async () => {
    const { client } = makeMockS3Client();
    const repo = makeAttachmentsRepo({ s3Client: client });
    const result = await repo.uploadAttachment({
      path: "hello.txt",
      mime: "text/plain",
      bytes: Buffer.from("hello"),
    });
    assert.equal(result.path, "hello.txt");
    assert.equal(typeof result.url, "string");
    assert.ok(result.url.includes("hello.txt"), `url should contain path: ${result.url}`);
  });

  it("download round-trips exact bytes and mime", async () => {
    const { client } = makeMockS3Client();
    const repo = makeAttachmentsRepo({ s3Client: client });
    const original = Buffer.from("binary\x00data\xff");
    await repo.uploadAttachment({
      path: "file.bin",
      mime: "application/octet-stream",
      bytes: original,
    });
    const result = await repo.downloadAttachment("file.bin");
    assert.ok(result !== null, "expected non-null result");
    assert.equal(result.mime, "application/octet-stream");
    assert.ok(Buffer.isBuffer(result.bytes), "bytes should be a Buffer");
    assert.deepEqual(result.bytes, original);
  });

  it("missing key returns null", async () => {
    const { client } = makeMockS3Client();
    const repo = makeAttachmentsRepo({ s3Client: client });
    const result = await repo.downloadAttachment("nonexistent.txt");
    assert.equal(result, null);
  });

  it("bucket isolation: attachments vs avatars use different keys", async () => {
    const { client, store } = makeMockS3Client();
    const repo = makeAttachmentsRepo({ s3Client: client });
    const bytesA = Buffer.from("attachments-data");
    const bytesB = Buffer.from("avatars-data");
    await repo.uploadAttachment({ path: "img.jpg", mime: "image/jpeg", bytes: bytesA, bucket: "attachments" });
    await repo.uploadAttachment({ path: "img.jpg", mime: "image/jpeg", bytes: bytesB, bucket: "avatars" });

    // Both keys exist but are different
    const keys = [...store.keys()];
    const attKey = keys.find(k => k.includes("attachments/attachments/img.jpg"));
    const avKey = keys.find(k => k.includes("attachments/avatars/img.jpg"));
    assert.ok(attKey, "attachments key should exist");
    assert.ok(avKey, "avatars key should exist");
    assert.notEqual(attKey, avKey);

    // Download from each bucket returns its own content
    const resA = await repo.downloadAttachment("img.jpg", { bucket: "attachments" });
    const resB = await repo.downloadAttachment("img.jpg", { bucket: "avatars" });
    assert.ok(resA && resB);
    assert.deepEqual(resA.bytes, bytesA);
    assert.deepEqual(resB.bytes, bytesB);
  });
});
