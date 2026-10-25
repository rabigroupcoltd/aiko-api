import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DELETE_ACCOUNT_PAGE } from './delete-account.page';

@ApiExcludeController()
@Controller('delete-account')
export class DeleteAccountPageController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  page(): string {
    return DELETE_ACCOUNT_PAGE;
  }
}
