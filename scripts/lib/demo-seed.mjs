// Logika seed tenant demo lewat API publik/administratif core-services. Idempoten: dijalankan
// ulang tidak menggandakan data. Diinjeksi `request(method, path, {token, body})` supaya dapat diuji.

export const DEMO = {
  slug: 'klinik-demo',
  tenantName: 'Klinik Demo',
  adminPhone: '6281200000001',
  location: { name: 'Pusat', code: 'pusat' },
  // Kredensial khusus demo lokal; jangan dipakai di luar mesin Anda.
  owner: { email: 'owner@klinik-demo.test', password: 'Demo-Owner-123' },
  caller: { email: 'caller@klinik-demo.test', password: 'Demo-Caller-123', role: 'STAFF_CALLER' },
  cashier: {
    email: 'cashier@klinik-demo.test',
    password: 'Demo-Cashier-123',
    role: 'STAFF_CASHIER',
  },
  services: [
    { name: 'Konsultasi', ticket_prefix: 'A', avg_duration_min: 15 },
    {
      name: 'Perawatan',
      ticket_prefix: 'B',
      avg_duration_min: 30,
      price: 100000,
      requires_dp: true,
      dp_amount: 50000,
    },
  ],
  resources: ['Dokter 1', 'Dokter 2'],
};

export const ALL_DAY_HOURS = {
  slot_interval_min: 30,
  days: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day_of_week: day,
    open_time: '00:00',
    close_time: '23:30',
    break_start: null,
    break_end: null,
  })),
};

function expect(label, response, ...statuses) {
  if (!statuses.includes(response.status)) {
    throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/**
 * `existingKiosk` = { token, locationId, expiresAt, isValid(token, locationId) }: token kiosk dari seed
 * sebelumnya dipakai ulang bila masih valid, supaya layar TV yang sudah terpasang tidak putus.
 */
export async function seedDemo(request, demo = DEMO, existingKiosk = null) {
  const created = [];
  const note = (text) => created.push(text);

  // 1. Tenant + lokasi + owner (409 = sudah ada -> cukup login).
  const registered = await request('POST', '/api/v1/auth/register', {
    body: {
      tenant: {
        name: demo.tenantName,
        slug: demo.slug,
        business_type: 'CLINIC',
        admin_wa_phone: demo.adminPhone,
      },
      location: demo.location,
      owner: demo.owner,
    },
  });
  if (registered.status === 201) note(`tenant "${demo.tenantName}" dibuat`);
  else expect('register', registered, 409);

  const login = async (user) => {
    const body = expect(
      `login ${user.email}`,
      await request('POST', '/api/v1/auth/login', {
        body: { email: user.email, password: user.password },
      }),
      200,
    );
    return body.access_token;
  };
  const token = await login(demo.owner);

  // 2. Lokasi.
  const locations = expect(
    'daftar lokasi',
    await request('GET', '/api/v1/locations', { token }),
    200,
  ).locations;
  const location = locations.find((item) => item.code === demo.location.code) ?? locations[0];
  if (!location) throw new Error('lokasi demo tidak ditemukan');

  // 3. Layanan.
  const existingServices = expect(
    'daftar layanan',
    await request('GET', '/api/v1/catalog/services', { token }),
    200,
  ).services;
  const serviceIds = [];
  for (const service of demo.services) {
    const found = existingServices.find((item) => item.name === service.name);
    if (found) {
      serviceIds.push(found.id);
      continue;
    }
    const body = expect(
      `layanan ${service.name}`,
      await request('POST', '/api/v1/catalog/services', { token, body: service }),
      201,
    );
    serviceIds.push(body.id);
    note(`layanan "${service.name}" dibuat`);
  }

  // 4. Resource + relasi layanan.
  const existingResources = expect(
    'daftar resource',
    await request('GET', `/api/v1/catalog/resources?location_id=${location.id}`, { token }),
    200,
  ).resources;
  const resourceIds = [];
  for (const name of demo.resources) {
    const found = existingResources.find((item) => item.name === name);
    if (found) {
      resourceIds.push(found.id);
      const linked = new Set(found.service_ids);
      if (serviceIds.some((id) => !linked.has(id)) || !found.is_active) {
        expect(
          `relasi ${name}`,
          await request('PATCH', `/api/v1/catalog/resources/${found.id}`, {
            token,
            body: { service_ids: serviceIds, is_active: true },
          }),
          200,
        );
        note(`resource "${name}" diperbarui`);
      }
      continue;
    }
    const body = expect(
      `resource ${name}`,
      await request('POST', '/api/v1/catalog/resources', {
        token,
        body: { location_id: location.id, name, service_ids: serviceIds },
      }),
      201,
    );
    resourceIds.push(body.id);
    note(`resource "${name}" dibuat`);
  }

  // 5. Jam operasional seharian + mode BOTH (PUT/PATCH idempoten).
  expect(
    'jam operasional',
    await request('PUT', `/api/v1/catalog/locations/${location.id}/operating-hours`, {
      token,
      body: ALL_DAY_HOURS,
    }),
    200,
  );
  expect(
    'mode layanan',
    await request('PATCH', '/api/v1/tenants/me/settings', {
      token,
      body: { service_mode: 'BOTH', show_wait_estimate: true },
    }),
    200,
  );

  // 6. Staf.
  for (const staff of [demo.caller, demo.cashier]) {
    const response = await request('POST', '/api/v1/users', {
      token,
      body: { email: staff.email, password: staff.password, role: staff.role },
    });
    if (response.status === 201) note(`staf ${staff.role} dibuat`);
    else expect(`staf ${staff.email}`, response, 409);
  }

  // 7. Token kiosk: pakai ulang yang lama bila masih valid; selain itu terbitkan yang baru.
  let kioskToken;
  let kioskExpiresAt;
  if (
    existingKiosk &&
    existingKiosk.locationId === location.id &&
    Date.parse(existingKiosk.expiresAt) > Date.now() + 86_400_000 &&
    (await existingKiosk.isValid(existingKiosk.token, location.id))
  ) {
    kioskToken = existingKiosk.token;
    kioskExpiresAt = existingKiosk.expiresAt;
  } else {
    const kiosk = expect(
      'token kiosk',
      await request('POST', `/api/v1/locations/${location.id}/kiosk-tokens`, { token }),
      201,
    );
    kioskToken = kiosk.token;
    kioskExpiresAt = kiosk.expires_at;
    note('token kiosk baru diterbitkan (token lama tetap berlaku sampai kedaluwarsa atau dicabut)');
  }

  return {
    created,
    locationId: location.id,
    serviceIds,
    resourceIds,
    kioskToken,
    kioskExpiresAt,
  };
}
