// FR-AUTH-07: staff management by the OWNER (GET/POST /users, PATCH /users/:id).
import {
  createStaffRequestSchema,
  updateStaffRequestSchema,
  uuidSchema,
} from '@antre/shared-types';
import type { FastifyPluginAsync } from 'fastify';

import { requireAuth, requireRoles, withTenant, type AppDeps } from '../auth/plugin.js';
import { hashPassword } from '../auth/password.js';
import { AppError, parseOrThrow, uniqueViolationConstraint } from '../errors.js';
import { insertStaff, listUsers, lockUserRole, toUserDto, updateStaff } from './queries.js';

export const usersRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  const ownerOnly = { preHandler: requireRoles('OWNER') };

  app.get('/', ownerOnly, async (request) => {
    const auth = requireAuth(request);
    const rows = await withTenant(deps, auth, (client) => listUsers(client));
    return { users: rows.map(toUserDto) };
  });

  app.post('/', ownerOnly, async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(createStaffRequestSchema, request.body);
    const passwordHash = await hashPassword(body.password);

    try {
      const row = await withTenant(deps, auth, (client) =>
        insertStaff(client, {
          tenantId: auth.tenantId!,
          email: body.email,
          passwordHash,
          role: body.role,
        }),
      );
      return await reply.status(201).send(toUserDto(row));
    } catch (error) {
      if (uniqueViolationConstraint(error) === 'users_email_key') {
        throw new AppError('ALREADY_EXISTS', 'Email sudah terdaftar.', {
          details: { field: 'email' },
        });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/:id', ownerOnly, async (request) => {
    const auth = requireAuth(request);
    const id = request.params.id;
    if (!uuidSchema.safeParse(id).success) {
      throw new AppError('NOT_FOUND', 'Pengguna tidak ditemukan.');
    }
    const body = parseOrThrow(updateStaffRequestSchema, request.body);
    const passwordHash =
      body.password === undefined ? undefined : await hashPassword(body.password);

    const row = await withTenant(deps, auth, async (client) => {
      const role = await lockUserRole(client, id);
      if (role === null) throw new AppError('NOT_FOUND', 'Pengguna tidak ditemukan.');
      if (role === 'OWNER') {
        throw new AppError('FORBIDDEN', 'Akun owner tidak dapat diubah melalui endpoint ini.');
      }
      return updateStaff(client, id, {
        role: body.role,
        passwordHash,
        isActive: body.is_active,
      });
    });
    return toUserDto(row);
  });
};
