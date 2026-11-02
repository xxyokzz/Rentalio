import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Parse .env manually from root or apps/api
function loadEnv() {
  const rootEnvPath = path.resolve(process.cwd(), '.env');
  const apiEnvPath = path.resolve(process.cwd(), 'apps/api/.env');
  const targetPath = fs.existsSync(rootEnvPath) ? rootEnvPath : apiEnvPath;

  if (!fs.existsSync(targetPath)) {
    console.error('❌ File .env tidak ditemukan di root maupun apps/api!');
    process.exit(1);
  }

  const content = fs.readFileSync(targetPath, 'utf8');
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      env[key] = val;
    }
  }
  return env;
}

const env = loadEnv();
const accountId = env.R2_ACCOUNT_ID;
const accessKeyId = env.R2_ACCESS_KEY_ID;
const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
const bucketName = env.R2_BUCKET_NAME;
const publicUrl = env.R2_PUBLIC_URL?.replace(/\/$/, '');

console.log('--- ☁️  Cloudflare R2 Connection Test ---');
console.log(`Account ID : ${accountId ? accountId.slice(0, 6) + '...' + accountId.slice(-4) : '(kosong)'}`);
console.log(`Access Key : ${accessKeyId ? accessKeyId.slice(0, 6) + '...' + accessKeyId.slice(-4) : '(kosong)'}`);
console.log(`Bucket     : ${bucketName || '(kosong)'}`);
console.log(`Public URL : ${publicUrl || '(kosong)'}\n`);

if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
  console.error('❌ Konfigurasi R2 belum lengkap di .env!');
  console.error('Pastikan R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, dan R2_BUCKET_NAME terisi.');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

async function runTest() {
  const testKey = `test-healthcheck-${Date.now()}.txt`;
  const testBody = `Cloudflare R2 connection test from Rentalio at ${new Date().toISOString()}`;

  try {
    // 1. Test List Objects (Bucket read access)
    console.log('1️⃣  Menguji koneksi & izin baca bucket (ListObjectsV2)...');
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      MaxKeys: 5,
    }));
    console.log(`   ✅ Berhasil terkoneksi ke bucket "${bucketName}".`);
    console.log(`   Objek ditemukan di bucket: ${listRes.KeyCount ?? 0} (menampilkan maks 5)`);

    // 2. Test Put Object (Upload)
    console.log(`\n2️⃣  Menguji upload file dummy "${testKey}" (PutObject)...`);
    await s3.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: testKey,
      Body: testBody,
      ContentType: 'text/plain',
    }));
    console.log('   ✅ Upload file berhasil!');

    // 3. Test Presigned URL
    console.log('\n3️⃣  Menguji pembuatan Presigned URL...');
    const presignedCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: `presigned-${testKey}`,
      ContentType: 'text/plain',
    });
    const presignedUrl = await getSignedUrl(s3, presignedCommand, { expiresIn: 300 });
    console.log('   ✅ Presigned URL berhasil dibuat!');
    console.log(`   Preview URL: ${presignedUrl.slice(0, 60)}...`);

    // 4. Test Public URL access (if provided)
    if (publicUrl) {
      console.log(`\n4️⃣  Mengecek akses Public URL (${publicUrl}/${testKey})...`);
      try {
        const pubRes = await fetch(`${publicUrl}/${testKey}`);
        if (pubRes.ok) {
          const fetchedText = await pubRes.text();
          console.log(`   ✅ Akses publik berhasil (HTTP ${pubRes.status})!`);
          console.log(`   Isi file: "${fetchedText}"`);
        } else {
          console.log(`   ⚠️  Public URL merespons HTTP ${pubRes.status} (${pubRes.statusText}).`);
          console.log('   Catatan: Pastikan Public Access / R2.dev subdomain sudah diaktifkan di Cloudflare dashboard.');
        }
      } catch (err) {
        console.log(`   ⚠️  Gagal fetch public URL: ${err.message}`);
      }
    }

    // 5. Test Delete Object (Cleanup)
    console.log(`\n5️⃣  Membersihkan file uji coba "${testKey}" (DeleteObject)...`);
    await s3.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key: testKey,
    }));
    console.log('   ✅ File uji coba berhasil dihapus dari bucket.');

    console.log('\n=========================================');
    console.log('🎉 SEMUA PENGUJIAN CLOUDFLARE R2 BERHASIL!');
    console.log('=========================================');
  } catch (error) {
    console.error('\n❌ Terjadi error saat menguji Cloudflare R2:');
    console.error(error);
    process.exit(1);
  }
}

runTest();
