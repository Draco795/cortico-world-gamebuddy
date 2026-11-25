/** 开发脚本共用的路径：包根目录与 Coopanion 世界数据目录。不写死本机路径。 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本脚本所在目录，也就是包根。 */
export const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Coopanion 的世界数据目录（generals-user.json、slang-user.json、harvest.json 都在这）。
 * 每台机器不一样，所以不写死：用环境变量 COOPANION_DATA 指定，没给就落到包内的 .local-data。
 */
export const DATA_DIR = process.env.COOPANION_DATA || join(ROOT, '.local-data');
