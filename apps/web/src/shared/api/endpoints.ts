import { apiRequest, apiRequestWithMeta } from "./client";
import type { components } from "./types.generated";

export type Schema<K extends keyof components["schemas"]> = components["schemas"][K];

export type SubscriptionInvoice = Schema<"SubscriptionInvoiceResponse">;

export type TenantSummary = {
  id?: string;
  slug?: string;
  name?: string;
  role?: "OWNER" | "MANAGER" | "STAFF" | "CASHIER";
};

export type CreateReservationResponse = Schema<"ReservationResponse">;
export type ReservationStatus = NonNullable<Schema<"ReservationResponse">["status"]>;
export type OrderStatus = NonNullable<Schema<"OrderResponse">["status"]>;
export type PaymentContext = NonNullable<Schema<"RecordPaymentRequest">["context"]>;
export type PaymentMethod = NonNullable<Schema<"RecordPaymentRequest">["method"]>;

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

// Endpoint auth publik tidak memakai sesi, sehingga tidak memerlukan X-CSRF-Token
// (`csrf: false`). Hanya logout (mutasi berbasis cookie) yang memerlukannya.
export const authApi = {
  register: (body: Schema<"RegisterRequest">) =>
    apiRequest<void>("/auth/registrations", { method: "POST", body, csrf: false }),

  verifyEmail: (body: Schema<"VerifyEmailRequest">) =>
    apiRequest<void>("/auth/registrations/verify-email", { method: "POST", body, csrf: false }),

  resendOtp: (body: Schema<"ResendOtpRequest">) =>
    apiRequest<void>("/auth/registrations/resend-otp", { method: "POST", body, csrf: false }),

  login: async (body: Schema<"LoginRequest">) => {
    const response = await apiRequestWithMeta<Schema<"SessionResponse">>("/auth/sessions", {
      method: "POST",
      body,
      csrf: false,
    });
    return {
      user: response.data.user,
      csrfToken: response.headers.get("x-csrf-token"),
    };
  },

  currentSession: () =>
    apiRequest<Schema<"SessionResponse">>("/auth/sessions/current", { silentAuth: true }),

  logout: () => apiRequest<void>("/auth/sessions/current", { method: "DELETE" }),

  requestPasswordReset: (body: Schema<"PasswordResetRequest">) =>
    apiRequest<void>("/auth/password-resets", { method: "POST", body, csrf: false }),

  completePasswordReset: (body: Schema<"CompletePasswordResetRequest">) =>
    apiRequest<void>("/auth/password-resets/complete", { method: "POST", body, csrf: false }),

  acceptInvitation: (body: Schema<"AcceptInvitationRequest">) =>
    apiRequest<{ userId?: string; tenantId?: string; role?: string; email?: string }>(
      "/auth/invitations/accept",
      { method: "POST", body, csrf: false },
    ),
};

export const tenantApi = {
  listMine: () => apiRequest<TenantSummary[]>("/tenants"),

  create: (body: Schema<"CreateTenantRequest">) =>
    apiRequest<{ id?: string; slug?: string; name?: string }>("/tenants", {
      method: "POST",
      body,
    }),

  get: (tenantId: string) => apiRequest<Schema<"TenantResponse">>(`/tenants/${tenantId}`),

  updateSettings: (tenantId: string, body: Schema<"UpdateTenantSettingsRequest">) =>
    apiRequest<void>(`/tenants/${tenantId}/settings`, { method: "PATCH", body }),

  listMembers: (tenantId: string) =>
    apiRequest<Schema<"MemberResponse">[]>(`/tenants/${tenantId}/members`),

  inviteMember: (tenantId: string, body: Schema<"InviteMemberRequest">) =>
    apiRequest<{ emailDelivered?: boolean }>(`/tenants/${tenantId}/members`, {
      method: "POST",
      body,
    }),

  updateMember: (tenantId: string, userId: string, body: Schema<"UpdateMemberRequest">) =>
    apiRequest<void>(`/tenants/${tenantId}/members/${userId}`, { method: "PATCH", body }),

  listDamageFeeRevisions: (tenantId: string) =>
    apiRequest<Schema<"DamageFeeRevisionResponse">[]>(
      `/tenants/${tenantId}/damage-fee-revisions`,
    ),

  restoreDamageFeeRevision: (tenantId: string, revisionId: string) =>
    apiRequest<Schema<"DamageFeeRevisionResponse">>(
      `/tenants/${tenantId}/damage-fee-revisions/${revisionId}/restore`,
      { method: "POST" },
    ),

  listDamageFeeCategories: (tenantId: string) =>
    apiRequest<Schema<"DamageFeeCategoryAmountResponse">[]>(
      `/tenants/${tenantId}/damage-fee-categories`,
    ),

  upsertDamageFeeCategory: (
    tenantId: string,
    body: Schema<"UpsertDamageFeeCategoryRequest">,
  ) =>
    apiRequest<Schema<"DamageFeeCategoryAmountResponse">>(
      `/tenants/${tenantId}/damage-fee-categories`,
      { method: "PUT", body },
    ),
};

/** Laporan operasional tenant. */
export const reportApi = {
  /** Piutang & denda belum lunas menurut umur; `alertCount` untuk badge. */
  receivableAging: (tenantId: string) =>
    apiRequest<Schema<"ReceivableAgingResponse">>(
      `/tenants/${tenantId}/reports/receivable-aging`,
    ),

  damageFees: (tenantId: string, params?: { from?: string; to?: string }) => {
    const search = new URLSearchParams();
    if (params?.from) search.set("from", params.from);
    if (params?.to) search.set("to", params.to);
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return apiRequest<Schema<"DamageFeeReportResponse">>(
      `/tenants/${tenantId}/reports/damage-fees${suffix}`,
    );
  },
};

/**
 * Tagihan langganan tenant → Rentalio (QRIS dinamis).
 *
 * `POST` menyiapkan QRIS bernominal; status lunas ditetapkan operator platform
 * setelah dana terverifikasi, bukan oleh respons ini. Klien tidak pernah
 * menandai tagihan lunas.
 */
export const billingApi = {
  listInvoices: (tenantId: string) =>
    apiRequest<SubscriptionInvoice[]>(`/tenants/${tenantId}/subscription-invoices`),

  createInvoice: (tenantId: string) =>
    apiRequest<SubscriptionInvoice>(`/tenants/${tenantId}/subscription-invoices`, {
      method: "POST",
    }),
};

/**
 * Endpoint penyewa publik (Notion 14) — tanpa sesi dan tanpa CSRF.
 * Harga, ketersediaan, dan status selalu dibaca server; tenant diresolusi
 * dari slug sehingga frontend tidak perlu mengetahui UUID tenant.
 */
export const publicApi = {
  getCatalog: (slug: string) =>
    apiRequest<Schema<"PublicCatalogResponse">>(
      `/public/${encodeURIComponent(slug)}/catalog`,
      { csrf: false },
    ),

  getCatalogConfig: (slug: string) =>
    apiRequest<Schema<"PublicCatalogConfigResponse">>(
      `/public/${encodeURIComponent(slug)}/catalog-config`,
      { csrf: false },
    ),

  getProduct: (slug: string, productId: string) =>
    apiRequest<Schema<"PublicProductDetailResponse">>(
      `/public/${encodeURIComponent(slug)}/products/${encodeURIComponent(productId)}`,
      { csrf: false },
    ),

  checkAvailability: (
    slug: string,
    params: { productId: string; startAt: string; endAt: string },
  ) =>
    apiRequest<Schema<"AvailabilityResponse">>(
      `/public/${encodeURIComponent(slug)}/availability${qs(params)}`,
      { csrf: false },
    ),

  createBooking: (
    slug: string,
    body: Schema<"CreatePublicBookingRequest">,
    idempotencyKey: string,
  ) =>
    apiRequest<Schema<"PublicBookingResponse">>(
      `/public/${encodeURIComponent(slug)}/bookings`,
      { method: "POST", body, csrf: false, idempotencyKey },
    ),
};

/**
 * Portal pesanan berbasis token. Satu-satunya mutasi adalah pengajuan
 * perpanjangan — tanpa sesi, tanpa CSRF, dan tetap menunggu keputusan staff.
 */
export const portalApi = {
  getOrder: (token: string) =>
    apiRequest<Schema<"PortalOrderResponse">>(
      `/portal/orders/${encodeURIComponent(token)}`,
      { csrf: false },
    ),

  disputeInspection: (
    token: string,
    inspectionId: string,
    body: Schema<"PortalInspectionDisputeRequest">,
  ) =>
    apiRequest<Schema<"PortalInspectionDisputeResult">>(
      `/portal/orders/${encodeURIComponent(token)}/inspections/${inspectionId}/dispute`,
      { method: "POST", body, csrf: false },
    ),

  requestExtension: (token: string, body: Schema<"PortalExtensionRequest">) =>
    apiRequest<{
      extension: Schema<"OrderExtensionResponse">;
      portalExpiresAt: string;
    }>(`/portal/orders/${encodeURIComponent(token)}/extensions`, {
      method: "POST",
      body,
      csrf: false,
    }),
};

export const catalogApi = {
  listCategories: (tenantId: string) =>
    apiRequest<Schema<"CategoryResponse">[]>(`/tenants/${tenantId}/categories`),

  createCategory: (tenantId: string, body: Schema<"CreateCategoryRequest">) =>
    apiRequest<Schema<"CategoryResponse">>(`/tenants/${tenantId}/categories`, {
      method: "POST",
      body,
    }),

  updateCategory: (tenantId: string, categoryId: string, body: Schema<"CreateCategoryRequest">) =>
    apiRequest<Schema<"CategoryResponse">>(`/tenants/${tenantId}/categories/${categoryId}`, {
      method: "PATCH",
      body,
    }),

  deleteCategory: (tenantId: string, categoryId: string) =>
    apiRequest<void>(`/tenants/${tenantId}/categories/${categoryId}`, { method: "DELETE" }),

  listProducts: (tenantId: string, filter: { categoryId?: string; isActive?: boolean } = {}) =>
    apiRequest<Schema<"ProductResponse">[]>(`/tenants/${tenantId}/products${qs(filter)}`),

  getProduct: (tenantId: string, productId: string) =>
    apiRequest<Schema<"ProductResponse"> & { assetCount?: number }>(
      `/tenants/${tenantId}/products/${productId}`,
    ),

  createProduct: (tenantId: string, body: Schema<"CreateProductRequest">) =>
    apiRequest<Schema<"ProductResponse">>(`/tenants/${tenantId}/products`, {
      method: "POST",
      body,
    }),

  updateProduct: (tenantId: string, productId: string, body: Schema<"UpdateProductRequest">) =>
    apiRequest<Schema<"ProductResponse">>(`/tenants/${tenantId}/products/${productId}`, {
      method: "PATCH",
      body,
    }),

  deactivateProduct: (tenantId: string, productId: string) =>
    apiRequest<void>(`/tenants/${tenantId}/products/${productId}`, { method: "DELETE" }),

  getRate: (tenantId: string, productId: string) =>
    apiRequest<Schema<"RateResponse"> | null>(`/tenants/${tenantId}/products/${productId}/rates`),

  upsertRate: (tenantId: string, productId: string, body: Schema<"UpsertRateRequest">) =>
    apiRequest<Schema<"RateResponse">>(`/tenants/${tenantId}/products/${productId}/rates`, {
      method: "POST",
      body,
    }),

  listAssets: (tenantId: string, productId: string) =>
    apiRequest<Schema<"AssetResponse">[]>(`/tenants/${tenantId}/products/${productId}/assets`),

  createAsset: (tenantId: string, productId: string, body: Schema<"CreateAssetRequest">) =>
    apiRequest<Schema<"AssetResponse">>(`/tenants/${tenantId}/products/${productId}/assets`, {
      method: "POST",
      body,
    }),

  updateAsset: (tenantId: string, assetId: string, body: Schema<"UpdateAssetRequest">) =>
    apiRequest<Schema<"AssetResponse">>(`/tenants/${tenantId}/assets/${assetId}`, {
      method: "PATCH",
      body,
    }),

  listMaintenance: (tenantId: string, assetId: string) =>
    apiRequest<Schema<"MaintenanceResponse">[]>(
      `/tenants/${tenantId}/assets/${assetId}/maintenance`,
    ),

  createMaintenance: (
    tenantId: string,
    assetId: string,
    body: Schema<"CreateMaintenanceRequest">,
  ) =>
    apiRequest<Schema<"MaintenanceResponse">>(
      `/tenants/${tenantId}/assets/${assetId}/maintenance`,
      { method: "POST", body },
    ),
};

export const availabilityApi = {
  check: (tenantId: string, params: { productId: string; startAt: string; endAt: string }) =>
    apiRequest<Schema<"AvailabilityResponse">>(
      `/tenants/${tenantId}/availability${qs(params)}`,
    ),
};

export const reservationApi = {
  list: (tenantId: string) =>
    apiRequest<Schema<"ReservationResponse">[]>(`/tenants/${tenantId}/reservations`),

  get: (tenantId: string, reservationId: string) =>
    apiRequest<Schema<"ReservationResponse">>(
      `/tenants/${tenantId}/reservations/${reservationId}`,
    ),

  create: (
    tenantId: string,
    body: Schema<"CreateReservationRequest">,
    idempotencyKey?: string,
  ) =>
    apiRequest<Schema<"ReservationResponse">>(`/tenants/${tenantId}/reservations`, {
      method: "POST",
      body,
      idempotencyKey,
    }),

  confirm: (tenantId: string, reservationId: string, body: Schema<"ConfirmReservationRequest"> = {}) =>
    apiRequest<Schema<"ReservationResponse">>(
      `/tenants/${tenantId}/reservations/${reservationId}/confirm`,
      { method: "POST", body },
    ),

  reject: (tenantId: string, reservationId: string, body: Schema<"RejectReservationRequest">) =>
    apiRequest<Schema<"ReservationResponse">>(
      `/tenants/${tenantId}/reservations/${reservationId}/reject`,
      { method: "POST", body },
    ),

  cancel: (tenantId: string, reservationId: string, body: Schema<"CancelReservationRequest">) =>
    apiRequest<Schema<"ReservationResponse">>(
      `/tenants/${tenantId}/reservations/${reservationId}/cancel`,
      { method: "POST", body },
    ),

  convertToOrder: (tenantId: string, reservationId: string) =>
    apiRequest<Schema<"OrderResponse">>(
      `/tenants/${tenantId}/reservations/${reservationId}/convert-to-order`,
      { method: "POST", body: {} },
    ),
};

export const orderApi = {
  list: (tenantId: string, filter: { status?: OrderStatus; page?: number; pageSize?: number } = {}) =>
    apiRequestWithMeta<Schema<"OrderResponse">[]>(
      `/tenants/${tenantId}/orders${qs(filter)}`,
    ).then((meta) => ({
      data: meta.data,
      page: Number(meta.payload?.page ?? filter.page ?? 1),
      pageSize: Number(meta.payload?.pageSize ?? filter.pageSize ?? 20),
      total: Number(meta.payload?.total ?? meta.data.length),
    })),

  get: (tenantId: string, orderId: string) =>
    apiRequest<Schema<"OrderResponse">>(`/tenants/${tenantId}/orders/${orderId}`),

  create: (tenantId: string, reservationId: string) =>
    apiRequest<Schema<"OrderResponse">>(`/tenants/${tenantId}/orders`, {
      method: "POST",
      body: { reservationId },
    }),

  markReadyForHandover: (tenantId: string, orderId: string, body: Schema<"ReadyForHandoverRequest"> = {}) =>
    apiRequest<Schema<"OrderResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/ready-for-handover`,
      { method: "POST", body },
    ),

  handover: (tenantId: string, orderId: string, body: Schema<"HandoverRequest">) =>
    apiRequest<Schema<"OrderResponse">>(`/tenants/${tenantId}/orders/${orderId}/handover`, {
      method: "POST",
      body,
    }),

  complete: (tenantId: string, orderId: string, body: Schema<"CompleteOrderRequest"> = {}) =>
    apiRequest<Schema<"OrderResponse">>(`/tenants/${tenantId}/orders/${orderId}/complete`, {
      method: "POST",
      body,
    }),

  listPayments: (tenantId: string, orderId: string) =>
    apiRequest<Schema<"PaymentResponse">[]>(`/tenants/${tenantId}/orders/${orderId}/payments`),

  recordPayment: (
    tenantId: string,
    orderId: string,
    body: Schema<"RecordPaymentRequest">,
    idempotencyKey?: string,
  ) =>
    apiRequest<Schema<"PaymentResponse">>(`/tenants/${tenantId}/orders/${orderId}/payments`, {
      method: "POST",
      body,
      idempotencyKey,
    }),

  voidPayment: (tenantId: string, paymentId: string, body: Schema<"VoidPaymentRequest">) =>
    apiRequest<Schema<"PaymentResponse">>(`/tenants/${tenantId}/payments/${paymentId}/void`, {
      method: "POST",
      body,
    }),

  listRefunds: (tenantId: string, orderId: string) =>
    apiRequest<Schema<"RefundResponse">[]>(`/tenants/${tenantId}/orders/${orderId}/refunds`),

  requestRefund: (tenantId: string, orderId: string, body: Schema<"RequestRefundRequest">) =>
    apiRequest<Schema<"RefundResponse">>(`/tenants/${tenantId}/orders/${orderId}/refunds`, {
      method: "POST",
      body,
    }),

  approveRefund: (tenantId: string, refundId: string, body: Schema<"RefundDecisionRequest">) =>
    apiRequest<Schema<"RefundResponse">>(`/tenants/${tenantId}/refunds/${refundId}/approve`, {
      method: "POST",
      body,
    }),

  recordRefundResult: (tenantId: string, refundId: string, body: Schema<"RefundResultRequest">) =>
    apiRequest<Schema<"RefundResponse">>(
      `/tenants/${tenantId}/refunds/${refundId}/record-result`,
      { method: "POST", body },
    ),

  /** Catat denda kerusakan dari inspeksi APPROVED sebagai tagihan order. */
  createPenalty: (
    tenantId: string,
    orderId: string,
    body: Schema<"CreateOrderPenaltyRequest">,
  ) =>
    apiRequest<Schema<"OrderPenaltyResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/penalties`,
      { method: "POST", body },
    ),

  /** Batalkan denda yang salah tagih; baris tetap ada sebagai riwayat. */
  voidPenalty: (tenantId: string, orderId: string, penaltyId: string, reason: string) =>
    apiRequest<Schema<"OrderPenaltyResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/penalties/${penaltyId}/void`,
      { method: "POST", body: { reason } },
    ),

  getDeposit: (tenantId: string, orderId: string) =>
    apiRequest<Schema<"DepositResponse">>(`/tenants/${tenantId}/orders/${orderId}/deposits`),

  receiveDeposit: (tenantId: string, orderId: string, body: Schema<"DepositReceiptRequest">) =>
    apiRequest<Schema<"DepositResponse">>(`/tenants/${tenantId}/orders/${orderId}/deposits`, {
      method: "POST",
      body,
    }),

  requestDepositDeduction: (
    tenantId: string,
    orderId: string,
    body: Schema<"DepositDeductionRequest">,
  ) =>
    apiRequest<Schema<"DepositDeductionRequestResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/deposit-deductions`,
      { method: "POST", body },
    ),

  approveDepositDeduction: (
    tenantId: string,
    requestId: string,
    body: Schema<"DepositDecisionRequest"> = {},
  ) =>
    apiRequest<Schema<"DepositDeductionRequestResponse">>(
      `/tenants/${tenantId}/deposit-deductions/${requestId}/approve`,
      { method: "POST", body },
    ),

  rejectDepositDeduction: (
    tenantId: string,
    requestId: string,
    body: Schema<"DepositDecisionRequest">,
  ) =>
    apiRequest<Schema<"DepositDeductionRequestResponse">>(
      `/tenants/${tenantId}/deposit-deductions/${requestId}/reject`,
      { method: "POST", body },
    ),

  refundDeposit: (tenantId: string, orderId: string, body: Schema<"DepositRefundRequest">) =>
    apiRequest<Schema<"DepositResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/deposit-refunds`,
      { method: "POST", body },
    ),

  reverseDepositMovement: (
    tenantId: string,
    orderId: string,
    movementId: string,
    body: Schema<"ReverseDepositMovementRequest">,
  ) =>
    apiRequest<Schema<"DepositResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/deposit-movements/${movementId}/reverse`,
      { method: "POST", body },
    ),

  listCollaterals: (tenantId: string, orderId: string) =>
    apiRequest<Schema<"CollateralResponse">[]>(
      `/tenants/${tenantId}/orders/${orderId}/collaterals`,
    ),

  createCollateral: (
    tenantId: string,
    orderId: string,
    body: Schema<"CreateCollateralRequest">,
    idempotencyKey?: string,
  ) =>
    apiRequest<Schema<"CollateralResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/collaterals`,
      { method: "POST", body, idempotencyKey },
    ),

  returnCollateral: (
    tenantId: string,
    collateralId: string,
    body: Schema<"ReturnCollateralRequest"> = {},
    idempotencyKey?: string,
  ) =>
    apiRequest<Schema<"CollateralResponse">>(
      `/tenants/${tenantId}/collaterals/${collateralId}/return`,
      { method: "POST", body, idempotencyKey },
    ),

  listWhatsAppMessages: (tenantId: string, orderId: string) =>
    apiRequest<Schema<"WhatsAppMessageResponse">[]>(
      `/tenants/${tenantId}/orders/${orderId}/whatsapp-messages`,
    ),
};

export const extensionApi = {
  /**
   * Antrean permintaan perpanjangan lintas order (default hanya yang
   * menunggu keputusan), untuk halaman Pesanan staf.
   */
  listTenant: (
    tenantId: string,
    status: "PENDING_APPROVAL" | "ALL" = "PENDING_APPROVAL",
  ) =>
    apiRequest<Schema<"TenantExtensionRequest">[]>(
      `/tenants/${tenantId}/extensions${qs({ status })}`,
    ),

  list: (tenantId: string, orderId: string) =>
    apiRequest<Schema<"OrderExtensionResponse">[]>(
      `/tenants/${tenantId}/orders/${orderId}/extensions`,
    ),

  get: (tenantId: string, orderId: string, extensionId: string) =>
    apiRequest<Schema<"OrderExtensionResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/extensions/${extensionId}`,
    ),

  request: (tenantId: string, orderId: string, body: Schema<"RequestExtensionRequest">) =>
    apiRequest<Schema<"OrderExtensionResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/extensions`,
      { method: "POST", body },
    ),

  approve: (tenantId: string, orderId: string, extensionId: string, body: Schema<"ApproveExtensionRequest">) =>
    apiRequest<Schema<"OrderExtensionResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/extensions/${extensionId}/approve`,
      { method: "POST", body },
    ),

  reject: (tenantId: string, orderId: string, extensionId: string, body: Schema<"RejectExtensionRequest">) =>
    apiRequest<Schema<"OrderExtensionResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/extensions/${extensionId}/reject`,
      { method: "POST", body },
    ),

  overrideConflict: (
    tenantId: string,
    orderId: string,
    extensionId: string,
    body: Schema<"OverrideExtensionConflictRequest">,
  ) =>
    apiRequest<Schema<"OrderExtensionResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/extensions/${extensionId}/override-conflict`,
      { method: "POST", body },
    ),

  resolveConflict: (
    tenantId: string,
    orderId: string,
    extensionId: string,
    conflictId: string,
    body: Schema<"ResolveExtensionConflictRequest">,
  ) =>
    apiRequest<Schema<"ResolveExtensionConflictResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/extensions/${extensionId}/conflicts/${conflictId}/resolve`,
      { method: "POST", body },
    ),

  conflictOverview: (tenantId: string, status: "OPEN" | "RESOLVED" | "ALL" = "OPEN") =>
    apiRequest<Schema<"ExtensionConflictOverview">>(
      `/tenants/${tenantId}/extension-conflicts${qs({ status })}`,
    ),
};

export const returnApi = {
  list: (tenantId: string, orderId: string) =>
    apiRequest<Schema<"ReturnRecordResponse">[]>(
      `/tenants/${tenantId}/orders/${orderId}/returns`,
    ),

  create: (tenantId: string, orderId: string, body: Schema<"CreateReturnRequest">) =>
    apiRequest<Schema<"ReturnRecordResponse">>(`/tenants/${tenantId}/orders/${orderId}/returns`, {
      method: "POST",
      body,
    }),

  get: (tenantId: string, returnId: string) =>
    apiRequest<Schema<"ReturnRecordResponse"> & {
      inspections?: Array<{ id?: string; status?: string; createdAt?: string }>;
    }>(`/tenants/${tenantId}/returns/${returnId}`),

  complete: (tenantId: string, returnId: string, body: Schema<"CompleteReturnRequest"> = {}) =>
    apiRequest<Schema<"ReturnRecordResponse">>(
      `/tenants/${tenantId}/returns/${returnId}/complete`,
      { method: "PATCH", body },
    ),

  cancel: (tenantId: string, returnId: string, body: Schema<"CancelReturnRequest">) =>
    apiRequest<Schema<"ReturnRecordResponse">>(
      `/tenants/${tenantId}/returns/${returnId}/cancel`,
      { method: "PATCH", body },
    ),
};

export const inspectionApi = {
  list: (tenantId: string, orderId: string) =>
    apiRequest<Schema<"InspectionResponse">[]>(
      `/tenants/${tenantId}/orders/${orderId}/inspections`,
    ),

  create: (tenantId: string, orderId: string, body: Schema<"CreateInspectionRequest">) =>
    apiRequest<Schema<"InspectionResponse">>(
      `/tenants/${tenantId}/orders/${orderId}/inspections`,
      { method: "POST", body },
    ),

  get: (tenantId: string, inspectionId: string) =>
    apiRequest<Schema<"InspectionResponse">>(
      `/tenants/${tenantId}/inspections/${inspectionId}`,
    ),

  submit: (tenantId: string, inspectionId: string, body: Schema<"SubmitInspectionRequest">) =>
    apiRequest<Schema<"InspectionResponse">>(
      `/tenants/${tenantId}/inspections/${inspectionId}/submit`,
      { method: "PATCH", body },
    ),

  decide: (tenantId: string, inspectionId: string, body: Schema<"DecideInspectionRequest">) =>
    apiRequest<Schema<"InspectionResponse">>(
      `/tenants/${tenantId}/inspections/${inspectionId}/decision`,
      { method: "PATCH", body },
    ),

  whatsappMessage: (tenantId: string, inspectionId: string) =>
    apiRequest<Schema<"InspectionWhatsAppMessageResponse">>(
      `/tenants/${tenantId}/inspections/${inspectionId}/whatsapp-message`,
    ),

  /** Putuskan ulang sengketa penyewa (UPHELD/REVISED). */
  resolveDispute: (
    tenantId: string,
    inspectionId: string,
    body: Schema<"ResolveInspectionDisputeRequest">,
  ) =>
    apiRequest<Schema<"InspectionResponse">>(
      `/tenants/${tenantId}/inspections/${inspectionId}/dispute/resolve`,
      { method: "POST", body },
    ),

  addAttachment: (
    tenantId: string,
    inspectionId: string,
    body: Schema<"CreateInspectionAttachmentRequest">,
  ) =>
    apiRequest<Schema<"InspectionResponse">>(
      `/tenants/${tenantId}/inspections/${inspectionId}/attachments`,
      { method: "POST", body },
    ),
};

/** Upload/unduh objek privat lewat presigned URL; kunci dibuat server. */
export const storageApi = {
  uploadUrl: (tenantId: string, body: Schema<"RequestStorageUploadUrl">) =>
    apiRequest<Schema<"StorageUploadUrlResponse">>(
      `/tenants/${tenantId}/storage/upload-url`,
      { method: "POST", body },
    ),

  downloadUrl: (tenantId: string, objectKey: string) =>
    apiRequest<Schema<"StorageDownloadUrlResponse">>(
      `/tenants/${tenantId}/storage/download-url${qs({ objectKey })}`,
    ),
};

export const paymentSettingsApi = {
  list: (tenantId: string) =>
    apiRequest<Schema<"PaymentMethodsResponse">>(
      `/tenants/${tenantId}/payment-methods`,
    ),

  update: (tenantId: string, body: Schema<"UpdatePaymentMethodsRequest">) =>
    apiRequest<Schema<"PaymentMethodsResponse">>(`/tenants/${tenantId}/payment-methods`, {
      method: "PUT",
      body,
    }),
};

export const whatsappTemplateApi = {
  list: (
    tenantId: string,
    filter: {
      context?: PaymentContext;
      paymentMethod?: PaymentMethod;
      purpose?: "PAYMENT_INSTRUCTION" | "PAYMENT_CONFIRMATION";
      status?: "ACTIVE" | "INACTIVE";
    } = {},
  ) =>
    apiRequest<Schema<"WhatsAppTemplateResponse">[]>(
      `/tenants/${tenantId}/whatsapp-templates${qs(filter)}`,
    ),

  get: (tenantId: string, templateId: string) =>
    apiRequest<Schema<"WhatsAppTemplateResponse">>(
      `/tenants/${tenantId}/whatsapp-templates/${templateId}`,
    ),

  create: (tenantId: string, body: Schema<"CreateWhatsAppTemplateRequest">) =>
    apiRequest<Schema<"WhatsAppTemplateResponse">>(
      `/tenants/${tenantId}/whatsapp-templates`,
      { method: "POST", body },
    ),

  update: (tenantId: string, templateId: string, body: Schema<"UpdateWhatsAppTemplateRequest">) =>
    apiRequest<Schema<"WhatsAppTemplateResponse">>(
      `/tenants/${tenantId}/whatsapp-templates/${templateId}`,
      { method: "PATCH", body },
    ),

  restoreDefault: (tenantId: string, templateId: string) =>
    apiRequest<Schema<"WhatsAppTemplateResponse">>(
      `/tenants/${tenantId}/whatsapp-templates/${templateId}/restore-default`,
      { method: "POST", body: {} },
    ),

  preview: (tenantId: string, body: Schema<"PreviewWhatsAppTemplateRequest">) =>
    apiRequest<Schema<"PreviewWhatsAppTemplateResponse">>(
      `/tenants/${tenantId}/whatsapp-templates/preview`,
      { method: "POST", body },
    ),
};

/**
 * Konfigurasi presentasi katalog (Notion 06 WEB-07). Draf disimpan di server
 * (bukan browser) dan hanya versi PUBLISHED yang tayang di katalog publik.
 */
export type CatalogConfigRequest = Schema<"CatalogConfigRequest">;
export type CatalogConfigState = Schema<"CatalogConfigStateResponse">;
export type CatalogConfigVersion = Schema<"CatalogConfigVersionResponse">;
export type CatalogConfigValidation = Schema<"CatalogConfigValidationResponse">;
export type CatalogConfigTemplate = Schema<"CatalogConfigTemplateSummary">;
export type CatalogConfigBlockDefinition = Schema<"CatalogConfigBlockDefinition">;
export type CatalogConfigSnapshot = NonNullable<Schema<"CatalogConfigSnapshot">>;

export const catalogConfigApi = {
  getState: (tenantId: string) =>
    apiRequest<CatalogConfigState>(`/tenants/${tenantId}/catalog-config`),

  saveDraft: (tenantId: string, body: CatalogConfigRequest) =>
    apiRequest<CatalogConfigVersion>(`/tenants/${tenantId}/catalog-config`, {
      method: "PUT",
      body,
    }),

  validate: (tenantId: string, body: CatalogConfigRequest) =>
    apiRequest<CatalogConfigValidation>(`/tenants/${tenantId}/catalog-config/validate`, {
      method: "POST",
      body,
    }),

  publish: (tenantId: string) =>
    apiRequest<{ published: CatalogConfigVersion; draft: CatalogConfigVersion }>(
      `/tenants/${tenantId}/catalog-config/publish`,
      { method: "POST", body: {} },
    ),

  versions: (tenantId: string) =>
    apiRequest<Schema<"CatalogConfigVersionSummary">[]>(
      `/tenants/${tenantId}/catalog-config/versions`,
    ),

  getVersion: (tenantId: string, versionId: string) =>
    apiRequest<CatalogConfigVersion>(
      `/tenants/${tenantId}/catalog-config/versions/${versionId}`,
    ),

  restore: (tenantId: string, versionId: string) =>
    apiRequest<CatalogConfigVersion>(
      `/tenants/${tenantId}/catalog-config/versions/${versionId}/restore`,
      { method: "POST", body: {} },
    ),

  templates: (tenantId: string) =>
    apiRequest<{ templates: CatalogConfigTemplate[]; blocks: CatalogConfigBlockDefinition[] }>(
      `/tenants/${tenantId}/catalog-config/templates`,
    ),

  applyTemplate: (tenantId: string, templateKey: string) =>
    apiRequest<CatalogConfigVersion>(
      `/tenants/${tenantId}/catalog-config/templates/${templateKey}/apply`,
      { method: "POST", body: {} },
    ),
};
