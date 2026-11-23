import { Controller, Get, Patch, Body, Request, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { requireHumanAuth, getUserId } from '../../common/helpers/get-user-id';

@ApiTags('Users')
@Controller('users')
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User profile retrieved successfully',
  })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async getCurrentUser(@Request() req) {
    requireHumanAuth(req.user);
    return this.usersService.getCurrentUser(getUserId(req.user));
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'User profile updated successfully',
  })
  @ApiBadRequestResponse({ description: 'Email already in use' })
  @ApiUnauthorizedResponse({ description: 'Unauthorized' })
  async updateCurrentUser(@Request() req, @Body() updateUserDto: UpdateUserDto) {
    requireHumanAuth(req.user);
    const result = await this.usersService.updateCurrentUser(getUserId(req.user), updateUserDto);
    return result;
  }
}
