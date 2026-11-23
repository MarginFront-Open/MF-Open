import { PartialType } from '@nestjs/swagger';
import { CreateSdkCustomerDto } from './create-sdk-customer.dto';

export class UpdateSdkCustomerDto extends PartialType(CreateSdkCustomerDto) {}
