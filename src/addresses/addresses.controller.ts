import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/current-user.decorator';
import { ResponsesService } from '../common/responses/responses.service';
import {
  ApiCreatedEnvelope,
  ApiForbidden,
  ApiNotFound,
  ApiOkEnvelope,
  ApiUnauthorized,
  ApiValidationError,
} from '../common/swagger/api-envelope.decorator';
import {
  ADDRESS_EXAMPLE,
  ADDRESS_LIST_EXAMPLE,
  ADDRESS_SEARCH_EXAMPLE,
} from '../common/swagger/examples';
import { AddressesService } from './addresses.service';
import { CreateAddressDto, SearchAddressDto, UpdateAddressDto } from './dto/address.dto';

const ADDRESS_ID_PARAM = { name: 'id', format: 'uuid', example: ADDRESS_EXAMPLE.id } as const;

@ApiTags('Addresses')
@ApiBearerAuth('bearer')
@Controller('addresses')
@UseGuards(AuthGuard('jwt'))
export class AddressesController {
  constructor(
    private addressesService: AddressesService,
    private response: ResponsesService,
  ) {}

  @Get('search')
  @ApiOperation({
    summary: 'Search for a place',
    description:
      "Cache-first. Matches the caller's saved addresses and the shared place cache before falling back to the Places API, and anything fetched remotely is cached for everyone. `source` on each row says which tier it came from; `id` is only set for rows the caller has saved. Without GOOGLE_MAPS_API_KEY the remote tier is skipped and only cached results come back.",
  })
  @ApiOkEnvelope(ADDRESS_SEARCH_EXAMPLE)
  @ApiValidationError('q must be longer than or equal to 2 characters')
  @ApiUnauthorized()
  async search(@CurrentUser('sub') userId: string, @Query() dto: SearchAddressDto) {
    try {
      const result = await this.addressesService.search(userId, dto);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Post()
  @ApiOperation({
    summary: 'Save an address',
    description:
      'Addresses are unique per user, so saving the same text twice updates the existing row. Setting `isDefault` clears the flag on the others.',
  })
  @ApiCreatedEnvelope(ADDRESS_EXAMPLE, { message: 'Address saved' })
  @ApiValidationError('address must be longer than or equal to 3 characters')
  @ApiUnauthorized()
  async create(@CurrentUser('sub') userId: string, @Body() dto: CreateAddressDto) {
    try {
      const result = await this.addressesService.create(userId, dto);
      return this.response.handleCreated(result, 'Address saved');
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get()
  @ApiOperation({ summary: 'List saved addresses', description: 'Default first, then newest.' })
  @ApiOkEnvelope(ADDRESS_LIST_EXAMPLE)
  @ApiUnauthorized()
  async findAll(@CurrentUser('sub') userId: string) {
    try {
      const result = await this.addressesService.findAll(userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one saved address' })
  @ApiParam(ADDRESS_ID_PARAM)
  @ApiOkEnvelope(ADDRESS_EXAMPLE)
  @ApiUnauthorized()
  @ApiForbidden('Not your address')
  @ApiNotFound('Address not found')
  async findOne(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    try {
      const result = await this.addressesService.findOne(id, userId);
      return this.response.handle(result);
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename or re-flag an address',
    description: 'Only the label and the default flag are editable — save a new row to change coordinates.',
  })
  @ApiParam(ADDRESS_ID_PARAM)
  @ApiOkEnvelope({ ...ADDRESS_EXAMPLE, name: 'Mum’s place' }, { message: 'Address updated' })
  @ApiValidationError('isDefault must be a boolean value')
  @ApiUnauthorized()
  @ApiForbidden('Not your address')
  @ApiNotFound('Address not found')
  async update(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateAddressDto,
  ) {
    try {
      const result = await this.addressesService.update(id, userId, dto);
      return this.response.handle(result, { message: 'Address updated' });
    } catch (e) {
      return this.response.exception(e);
    }
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a saved address',
    description: 'Removes the personal row only — the shared place cache is untouched.',
  })
  @ApiParam(ADDRESS_ID_PARAM)
  @ApiOkEnvelope({ deleted: true, id: ADDRESS_EXAMPLE.id }, { message: 'Address deleted' })
  @ApiUnauthorized()
  @ApiForbidden('Not your address')
  @ApiNotFound('Address not found')
  async remove(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    try {
      const result = await this.addressesService.remove(id, userId);
      return this.response.handle(result, { message: 'Address deleted' });
    } catch (e) {
      return this.response.exception(e);
    }
  }
}
