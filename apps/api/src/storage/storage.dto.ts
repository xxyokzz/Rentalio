import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export enum StorageUploadCategory {
  BRANDING = 'branding',
  PRODUCTS = 'products',
  RECEIPTS = 'receipts',
  GENERAL = 'general',
}

export class RequestUploadUrlDto {
  @IsEnum(StorageUploadCategory, {
    message: 'Kategori upload harus salah satu dari: branding, products, receipts, general',
  })
  category!: StorageUploadCategory;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  contentType!: string;
}
