import fs from "node:fs/promises";
import path from "node:path";
import { Client as MinioClient } from "minio";

export interface ObjectStorage {
  putObject(objectKey: string, body: Buffer): Promise<void>;
  getObject(objectKey: string): Promise<Buffer>;
}

export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly baseDir: string) {}

  async putObject(objectKey: string, body: Buffer): Promise<void> {
    const target = path.join(this.baseDir, objectKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }

  async getObject(objectKey: string): Promise<Buffer> {
    const target = path.join(this.baseDir, objectKey);
    return fs.readFile(target);
  }
}

export type MinioConfig = {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

export class MinioObjectStorage implements ObjectStorage {
  private readonly client: MinioClient;
  private initPromise?: Promise<void>;

  constructor(private readonly config: MinioConfig) {
    this.client = new MinioClient({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey
    });
  }

  async putObject(objectKey: string, body: Buffer): Promise<void> {
    await this.ensureBucket();
    await this.client.putObject(this.config.bucket, objectKey, body);
  }

  async getObject(objectKey: string): Promise<Buffer> {
    await this.ensureBucket();
    const stream = await this.client.getObject(this.config.bucket, objectKey);
    const chunks: Buffer[] = [];

    return await new Promise((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }

  private async ensureBucket(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.ensureBucketInternal();
    }

    await this.initPromise;
  }

  private async ensureBucketInternal(): Promise<void> {
    const exists = await this.client.bucketExists(this.config.bucket).catch(() => false);
    if (!exists) {
      await this.client.makeBucket(this.config.bucket, "us-east-1");
    }
  }
}
