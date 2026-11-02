import { Global, Module } from '@nestjs/common';
import { AppConfig, ConfigError, validateConfig } from './env.validation.js';

/**
 * ConfigModule global: validasi env saat startup (fail-fast, tanpa
 * mencetak nilai secret). Konfigurasi wajib yang hilang → startup gagal
 * dengan pesan jelas (dokumen 12 S0-05).
 */
const configProvider = {
  provide: 'APP_CONFIG',
  useFactory: (): AppConfig => {
    try {
      return validateConfig(process.env);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw err;
      }
      throw err;
    }
  },
};

@Global()
@Module({
  providers: [configProvider],
  exports: ['APP_CONFIG'],
})
export class ConfigModule {}
