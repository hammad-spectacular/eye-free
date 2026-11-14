/* ==========================================================================
   voucher-api.js
   --------------------------------------------------------------------------
   The browser side of the fee voucher generator. It talks to the real
   /api/fees endpoints of The Eye, so the page shows the school's actual
   students, classes and fee rules, and the vouchers and receipts it makes are
   stored in the database for everyone to see.

   It offers the same small interface as the demo API (voucher-demo-api.js),
   so the page works against either one. Every call is asynchronous: the
   answers come from the server.

   If the server cannot be reached, or the browser is not signed in, the page
   falls back to the demo data so the screen is never empty and broken.
   ========================================================================== */

(function (root) {
  'use strict';

  const BASE = '/api/fees';

  /** An error that carries what the server said, e.g. a refused payment. */
  class ApiError extends Error {
    constructor(message, refused) {
      super(message);
      this.name = refused ? 'Refused' : 'Error';
      this.refused = !!refused;
    }
  }

  async function request(path, options = {}) {
    const response = await fetch(BASE + path, {
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }

    if (!response.ok) {
      const message = (payload && payload.error) || `The fee service did not answer (${response.status}).`;
      throw new ApiError(message, payload && payload.refused);
    }
    return payload;
  }

  const api = {
    /** True when the real fee service answered. */
    online: false,

    /** What the server told us the school looks like. */
    cache: null,

    /**
     * Asks the server for the school: its classes, its students and its fee
     * rules. It is fetched once and kept, so opening the page reads the
     * database a single time.
     */
    async bootstrap() {
      if (!api.cache) api.cache = await request('/bootstrap');
      return api.cache;
    },

    /** Asks the server whether the real fee service is there. */
    async probe() {
      try {
        // The status answer never fails, so a browser that is not signed in
        // does not fill the console with errors.
        const status = await request('/status');
        if (!status.signedIn) {
          api.online = false;
          return false;
        }
        await api.bootstrap();
        api.online = true;
        return true;
      } catch (err) {
        api.online = false;
        api.cache = null;
        return false;
      }
    },

    // --- Fee settings -------------------------------------------------------

    async settings() {
      const data = await api.bootstrap();
      return { dueDays: data.settings?.dueDays ?? 10, lateFine: data.settings?.lateFine ?? 0 };
    },

    async saveSettings(next) {
      const data = await request('/settings', { method: 'PUT', body: next });
      if (api.cache) {
        api.cache.settings = { dueDays: data.dueDays, lateFine: data.lateFine };
      }
      return { dueDays: data.dueDays, lateFine: data.lateFine };
    },

    // --- The school ---------------------------------------------------------

    async classes() {
      const data = await api.bootstrap();
      return data.classes || [];
    },

    async students() {
      const data = await api.bootstrap();
      return data.students || [];
    },

    // --- Vouchers -----------------------------------------------------------

    async listFees({ month, year, classId, status, search, limit = 10000 } = {}) {
      const params = new URLSearchParams();
      if (month && month !== 'all') params.set('month', month);
      if (year && year !== 'all') params.set('year', year);
      if (classId && classId !== 'all') params.set('classId', classId);
      if (status && status !== 'all') params.set('status', status);
      if (search) params.set('search', search);
      const query = params.toString();
      const fees = await request('/vouchers' + (query ? `?${query}` : ''));
      return fees.slice(0, limit);
    },

    async generateFees({ month, year, classId, studentIds } = {}) {
      return request('/vouchers/generate', { method: 'POST', body: { month, year, classId, studentIds } });
    },

    async setCharges(voucherId, charges) {
      const data = await request(`/vouchers/${encodeURIComponent(voucherId)}/charges`, {
        method: 'PUT',
        body: { charges },
      });
      return data.voucher;
    },

    async addCharge(voucherIds, charge) {
      return request('/vouchers/charges', { method: 'POST', body: { voucherIds, charge } });
    },

    async reverseVoucher(voucherId) {
      return request(`/vouchers/${encodeURIComponent(voucherId)}`, { method: 'DELETE' });
    },

    // --- Payments -----------------------------------------------------------

    async receivePayment(voucherId, input) {
      return request('/receipts', { method: 'POST', body: { voucherId, ...input } });
    },

    async reversePayment(receiptId) {
      return request(`/receipts/${encodeURIComponent(receiptId)}/reverse`, { method: 'POST' });
    },

    async payments() {
      return request('/receipts');
    },

    // --- Branding (logo, bank details, saved charges) ------------------------

    async branding() {
      const data = await api.bootstrap();
      return data.branding || {};
    },

    async saveBranding(branding) {
      await request('/branding', { method: 'PUT', body: { branding } });
      if (api.cache) api.cache.branding = branding;
      return branding;
    },

    // --- Demo-only helpers --------------------------------------------------

    /**
     * The real records are never wiped from a button. The page hides the demo
     * controls when it is talking to the server.
     */
    async reset() {
      throw new ApiError('These are real fee records, so they cannot be reset from here.', false);
    },

    async hardReset() {
      throw new ApiError('These are real fee records, so they cannot be reset from here.', false);
    },
  };

  root.VGFeeApi = api;
  root.VGApiError = ApiError;
})(typeof self !== 'undefined' ? self : this);
