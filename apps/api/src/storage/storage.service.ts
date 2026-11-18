import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/env.validation.js';

/**
 * StorageService — wrapper Cloudflare R2 (S3-compatible).
 * Menyediakan presigned URL untuk upload langsung dari browser,
 * dan hapus objek dari bucket. Tidak menyentuh objek secara langsung
 * dari server; upload dilakukan client-side langsung ke R2.
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(@Inject('APP_CONFIG') config: AppConfig) {
    this.bucket = config.R2_BUCKET_NAME;
    this.publicBaseUrl = config.R2_PUBLIC_URL.replace(/\/$/, '');

    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  /**
   * Buat presigned URL untuk upload langsung dari browser ke R2.
   * Expire default 15 menit; size maksimum dikontrol di sisi R2 bucket policy.
   */
  async createUploadUrl(
    objectKey: string,
    contentType: string,
    expiresInSeconds = 900,
  ): Promise<{ uploadUrl: string; objectKey: string; publicUrl: string }> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3, command, {
      expiresIn: expiresInSeconds,
    });

    return {
      uploadUrl,
      objectKey,
      publicUrl: `${this.publicBaseUrl}/${objectKey}`,
    };
  }

  /**
   * Buat presigned URL khusus tenant dengan isolasi path otomatis:
   * tenants/{tenantId}/{category}/{uuid}.{ext}
   */
  async createTenantUploadUrl(
    tenantId: string,
    category: string,
    originalFilename: string,
    contentType: string,
    expiresInSeconds = 900,
  ): Promise<{ uploadUrl: string; objectKey: string; publicUrl: string }> {
    const ext = originalFilename.includes('.')
      ? originalFilename.split('.').pop()?.toLowerCase() ?? 'bin'
      : 'bin';
    const randomSuffix = randomUUID();
    const objectKey = `tenants/${tenantId}/${category}/${randomSuffix}.${ext}`;

    return this.createUploadUrl(objectKey, contentType, expiresInSeconds);
  }

  /**
   * Presigned URL baca berumur pendek untuk objek privat.
   *
   * Lampiran inspeksi tidak boleh diakses lewat URL publik permanen; tautan
   * ini ditandatangani dengan kredensial server dan kedaluwarsa cepat.
   */
  async createDownloadUrl(objectKey: string, expiresInSeconds = 300): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    });
    return getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Hapus objek dari bucket.
   */
  async deleteObject(objectKey: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
    );
  }

  /**
   * Bangun URL publik dari objectKey (tanpa signed).
   * Hanya valid bila bucket memiliki custom domain / public access.
   */
  getPublicUrl(objectKey: string): string {
    return `${this.publicBaseUrl}/${objectKey}`;
  }
}
