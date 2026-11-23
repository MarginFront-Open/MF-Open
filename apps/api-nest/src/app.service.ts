import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    };
  }

  getRoot() {
    return {
      message: 'Welcome to MarginFront NestJS API',
      version: '1.0.0',
      documentation: '/api-docs',
    };
  }
}
