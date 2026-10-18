import { describe, expect, it } from 'vitest';

import {
  brandingSchema,
  createStaffRequestSchema,
  emailSchema,
  loginRequestSchema,
  registerRequestSchema,
  slugSchema,
  updateStaffRequestSchema,
  updateTenantSettingsRequestSchema,
} from './index.js';

const validRegister = {
  tenant: {
    name: 'Klinik Sehat',
    slug: 'klinik-sehat',
    business_type: 'CLINIC',
    admin_wa_phone: '6281234567890',
  },
  location: { name: 'Pusat', code: 'pusat' },
  owner: { email: 'owner@example.com', password: 'password-ok' },
};

describe('field schemas', () => {
  it('normalises email', () => {
    expect(emailSchema.parse(' Owner@Example.COM ')).toBe('owner@example.com');
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('rejects an invalid slug', () => {
    expect(slugSchema.safeParse('Bad Slug').success).toBe(false);
    expect(slugSchema.safeParse('-bad').success).toBe(false);
    expect(slugSchema.safeParse('good-slug-1').success).toBe(true);
  });
});

describe('registerRequestSchema', () => {
  it('accepts a valid body and defaults the timezone', () => {
    const parsed = registerRequestSchema.parse(validRegister);
    expect(parsed.location.timezone).toBe('Asia/Jakarta');
  });

  it('rejects a 7 character password', () => {
    const result = registerRequestSchema.safeParse({
      ...validRegister,
      owner: { email: 'owner@example.com', password: '1234567' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys at every level', () => {
    expect(registerRequestSchema.safeParse({ ...validRegister, extra: 1 }).success).toBe(false);
    expect(
      registerRequestSchema.safeParse({
        ...validRegister,
        tenant: { ...validRegister.tenant, plan: 'PAID' },
      }).success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({
        ...validRegister,
        owner: { ...validRegister.owner, role: 'SUPER_ADMIN' },
      }).success,
    ).toBe(false);
  });
});

describe('branding and logo', () => {
  it('rejects non-https logo urls', () => {
    expect(brandingSchema.safeParse({ logo_url: 'http://example.com/a.png' }).success).toBe(false);
    expect(brandingSchema.safeParse({ logo_url: 'javascript:alert(1)' }).success).toBe(false);
    expect(brandingSchema.safeParse({ logo_url: 'https://example.com/a.png' }).success).toBe(true);
  });

  it('validates accent color and rejects unknown keys', () => {
    expect(brandingSchema.safeParse({ accent_color: 'red' }).success).toBe(false);
    expect(brandingSchema.safeParse({ accent_color: '#1A2b3C' }).success).toBe(true);
    expect(brandingSchema.safeParse({ font: 'serif' }).success).toBe(false);
    expect(brandingSchema.safeParse({ labels: { other: 'x' } }).success).toBe(false);
  });
});

describe('login and staff schemas', () => {
  it('does not enforce a minimum password length on login', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });

  it('only allows staff roles when creating staff', () => {
    const base = { email: 'staff@example.com', password: 'password-ok' };
    expect(createStaffRequestSchema.safeParse({ ...base, role: 'STAFF_CALLER' }).success).toBe(
      true,
    );
    expect(createStaffRequestSchema.safeParse({ ...base, role: 'OWNER' }).success).toBe(false);
    expect(createStaffRequestSchema.safeParse({ ...base, role: 'SUPER_ADMIN' }).success).toBe(
      false,
    );
  });

  it('rejects an empty update and non-staff roles', () => {
    expect(updateStaffRequestSchema.safeParse({}).success).toBe(false);
    expect(updateStaffRequestSchema.safeParse({ role: 'OWNER' }).success).toBe(false);
    expect(updateStaffRequestSchema.safeParse({ role: 'SUPER_ADMIN' }).success).toBe(false);
    expect(updateStaffRequestSchema.safeParse({ is_active: false }).success).toBe(true);
    expect(updateStaffRequestSchema.safeParse({ is_active: false, foo: 1 }).success).toBe(false);
  });
});

describe('updateTenantSettingsRequestSchema', () => {
  it('rejects an empty update and unknown keys', () => {
    expect(updateTenantSettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(updateTenantSettingsRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('accepts a partial update', () => {
    const result = updateTenantSettingsRequestSchema.safeParse({
      service_mode: 'RESERVATION',
      show_wait_estimate: false,
    });
    expect(result.success).toBe(true);
  });
});
