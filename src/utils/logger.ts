/**
 * @file utils/logger.ts
 * @description Конфигурация Winston-логгера для m006 с файловыми транспортами
 * @context Логи пишутся в stdout + файлы (app/, error/, access/, frontend/) для персистентности вне контейнера
 * @dependencies winston, winston-daily-rotate-file, config
 * @affects Все модули через logger.info/warn/error, frontendLogger, accessLogger
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { config } from '../config';

/** Путь к директории логов (монтируется как volume вне контейнера) */
const LOG_DIR = process.env.LOG_PATH || path.join(process.cwd(), 'logs');

/** Формат для консольного вывода (человекочитаемый) */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, requestId, ...meta }: Record<string, unknown>) => {
    const reqId = requestId ? `[${requestId}]` : '';
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
    return `${timestamp} [${level}] ${reqId} ${message} ${metaStr}`.trim();
  })
);

/** Формат для файлового вывода (JSON для машинного анализа) */
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const appFileTransport = new DailyRotateFile({
  dirname: path.join(LOG_DIR, 'app'),
  filename: 'app-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m',
  maxFiles: '7d',
  format: fileFormat,
  zippedArchive: false,
});

const errorFileTransport = new DailyRotateFile({
  dirname: path.join(LOG_DIR, 'error'),
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  maxSize: '20m',
  maxFiles: '7d',
  format: fileFormat,
  zippedArchive: false,
});

const accessFileTransport = new DailyRotateFile({
  dirname: path.join(LOG_DIR, 'access'),
  filename: 'access-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m',
  maxFiles: '7d',
  format: fileFormat,
  zippedArchive: false,
});

const frontendFileTransport = new DailyRotateFile({
  dirname: path.join(LOG_DIR, 'frontend'),
  filename: 'frontend-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '30m',
  maxFiles: '7d',
  format: fileFormat,
  zippedArchive: false,
});

export const logger = winston.createLogger({
  level: config.logLevel,
  defaultMeta: { module_id: config.moduleId },
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    appFileTransport,
    errorFileTransport,
  ],
});

export const accessLogger = winston.createLogger({
  level: 'info',
  defaultMeta: { module_id: config.moduleId, log_type: 'access' },
  transports: [
    accessFileTransport,
  ],
});

export const frontendLogger = winston.createLogger({
  level: 'debug',
  defaultMeta: { module_id: config.moduleId, log_type: 'frontend' },
  transports: [
    frontendFileTransport,
  ],
});

appFileTransport.on('error', (err: Error) => {
  console.error('[logger] App file transport error:', err.message);
});
errorFileTransport.on('error', (err: Error) => {
  console.error('[logger] Error file transport error:', err.message);
});
accessFileTransport.on('error', (err: Error) => {
  console.error('[logger] Access file transport error:', err.message);
});
frontendFileTransport.on('error', (err: Error) => {
  console.error('[logger] Frontend file transport error:', err.message);
});

/**
 * Создаёт дочерний логгер с привязкой к request_id
 */
export function createRequestLogger(requestId: string) {
  return logger.child({ requestId });
}
