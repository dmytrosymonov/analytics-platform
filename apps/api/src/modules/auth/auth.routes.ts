import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { verifyPassword } from '../../lib/password';
import { writeAuditLog } from '../../lib/audit';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const admin = await prisma.adminUser.findUnique({
      where: { email: body.email },
    });

    if (!admin || !admin.isActive) {
      return reply.status(401).send({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const valid = await verifyPassword(body.password, admin.passwordHash);
    if (!valid) {
      return reply.status(401).send({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const token = app.jwt.sign({ sub: admin.id, role: admin.role, name: admin.name });

    await writeAuditLog({
      actorType: 'admin',
      actorId: admin.id,
      action: 'auth.login',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.send({ success: true, data: { token, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } } });
  });

  app.get('/me', { onRequest: [(app as any).authenticate] }, async (request, reply) => {
    const payload = request.user as any;
    const admin = await prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin) return reply.status(404).send({ success: false, error: { message: 'Not found' } });
    return reply.send({ success: true, data: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
  });
}
