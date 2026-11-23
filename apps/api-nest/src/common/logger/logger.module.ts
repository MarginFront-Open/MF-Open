import { Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';

const logLevel = process.env.LOG_LEVEL || 'info';
const isDevelopment = process.env.NODE_ENV === 'development';
const isServerless = process.env.VERCEL === '1' || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

@Module({
  imports: [
    WinstonModule.forRoot({
      level: logLevel,
      format: winston.format.combine(
        winston.format.timestamp({
          format: 'YYYY-MM-DD HH:mm:ss',
        }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json(),
      ),
      defaultMeta: {
        service: 'marginfront-api-nest',
        environment: process.env.NODE_ENV || 'development',
      },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize({ all: true }),
            winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
              let msg = `${timestamp} [${level}] ${context ? `[${context}]` : ''} ${message}`;
              if (Object.keys(meta).length > 0) {
                msg += ` ${JSON.stringify(meta)}`;
              }
              return msg;
            }),
          ),
        }),
        // No error file in development or on serverless hosts.
        ...(isDevelopment || isServerless
          ? []
          : [
              new winston.transports.File({
                filename: 'logs/error.log',
                level: 'error',
              }),
              new winston.transports.File({
                filename: 'logs/combined.log',
              }),
            ]),
      ],
    }),
  ],
  exports: [WinstonModule],
})
export class LoggerModule {}
