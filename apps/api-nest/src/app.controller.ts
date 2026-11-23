import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './modules/auth/decorators/public.decorator';

@ApiTags('Health')
@Controller()
@Public() // Health and root endpoints are public - no authentication required
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({
    status: 200,
    description: 'Service is healthy',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', example: '2025-12-22T10:00:00.000Z' },
        uptime: { type: 'number', example: 12345 },
        environment: { type: 'string', example: 'development' },
      },
    },
  })
  getHealth() {
    return this.appService.getHealth();
  }

  @Get()
  @ApiOperation({ summary: 'Root endpoint' })
  @ApiResponse({
    status: 200,
    description: 'Welcome message',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Welcome to MarginFront API' },
        version: { type: 'string', example: '1.0.0' },
        documentation: { type: 'string', example: '/api-docs' },
      },
    },
  })
  getRoot() {
    return this.appService.getRoot();
  }
}
