// =============================================================================
// GET /api/users/me/library (RETRO-I6, #588)
// =============================================================================
//
// The caller's personal library: "My library" in the web owner switcher. The
// platform's `/api/groups?scope=mine` lists the caller's SHARED libraries; the
// personal one is not a group (decision 3 of circles-to-groups.md), so the
// client asks for it here. `id` is the scope id every owner-scoped route takes
// as `scope=me` (or, deprecated, `circleId`): today the former personal
// circle's id. Self-scoped, authentication only, no permission (the same
// rationale as `GET /api/users/me/profile`). It replaces the web's last use of
// `GET /api/circles`.
// =============================================================================

import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { Auth } from '@marinoscar/platform-api/identity';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaModule } from '../../prisma/prisma.module';
import { PersonalLibraryStore } from './personal-library.store';

/** The display name the clients show for the personal library. */
export const PERSONAL_LIBRARY_NAME = 'My library';

const personalLibrarySchema = z.object({
  id: z.string().uuid().nullable().describe('The personal library scope id, or null when the account has none yet.'),
  name: z.string(),
});

export class PersonalLibraryDto extends createZodDto(personalLibrarySchema) {}

@Injectable()
export class PersonalLibraryService {
  constructor(private readonly store: PersonalLibraryStore) {}

  /** The caller's personal library. */
  async forUser(userId: string): Promise<PersonalLibraryDto> {
    return { id: await this.store.idOf(userId), name: PERSONAL_LIBRARY_NAME };
  }
}

@ApiTags('Users')
@Controller('users')
export class PersonalLibraryController {
  constructor(private readonly libraries: PersonalLibraryService) {}

  @Get('me/library')
  @Auth()
  @ApiOperation({
    summary: "Get the caller's personal library",
    description:
      'The personal library ("My library") the owner switcher lists before the caller\'s groups ' +
      '(`GET /api/groups?scope=mine`). Owner-scoped routes take it as `scope=me`.',
  })
  @ApiResponse({ status: 200, description: 'The personal library', type: PersonalLibraryDto })
  async getMine(@CurrentUser('id') userId: string): Promise<PersonalLibraryDto> {
    return this.libraries.forUser(userId);
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [PersonalLibraryController],
  providers: [PersonalLibraryService, PersonalLibraryStore],
})
export class PersonalLibraryModule {}
