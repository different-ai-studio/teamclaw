// Aliyun SMS sender for phone-auth verification codes, ported from the partner
// SaaS (`apps/api/src/lib/dysms.ts` + `services/metadata.ts` there).
//
// Config is NOT env-based: it lives in the shared `public.metadata` table,
// org-scoped (`name='ALIYUN_SMS_CONFIG'`). When teamclaw's DEFAULT_ORG_ID is an
// org owned by the partner SaaS, reading that org's metadata reuses the
// partner's existing SMS account/template — no new credentials needed.
import * as $OpenApi from "@alicloud/openapi-client";
import Dysmsapi, { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { REALTIME_TRANSPORT_OPTS } from "./supabase-repo/shared.js";

const VERIFY_TEMPLATE_KEY = "SMS_VERIFY_CODE";

interface DysmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templates: Record<string, string>;
}

function createDysmsClient(accessKeyId: string, accessKeySecret: string) {
  const config = new $OpenApi.Config({ accessKeyId, accessKeySecret });
  config.endpoint = "dysmsapi.aliyuncs.com";
  // The SDK ships a CJS default-export quirk; mirror the partner's interop cast.
  const Ctor = (Dysmsapi as any).default ?? Dysmsapi;
  return new Ctor(config) as {
    sendSmsWithOptions: (
      req: SendSmsRequest,
      opts: Record<string, unknown>,
    ) => Promise<{ body?: { code?: string; message?: string } }>;
  };
}

/**
 * Build an injectable `sendSms({ phone, code, orgId })` for the phone-auth repo.
 * Reads ALIYUN_SMS_CONFIG from the shared metadata table via a service-role
 * client, then sends the SMS_VERIFY_CODE template.
 */
export function makeDysmsSender(deps: {
  createClient: (url: string, key: string, opts?: any) => any;
  supabaseUrl: string;
  serviceRoleKey: string;
}) {
  const admin = deps.createClient(deps.supabaseUrl, deps.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" }, realtime: REALTIME_TRANSPORT_OPTS,
  });

  async function getSmsConfig(orgId: string): Promise<DysmsConfig> {
    const { data, error } = await admin
      .from("metadata")
      .select("value")
      .eq("org_id", orgId)
      .eq("name", "ALIYUN_SMS_CONFIG")
      .maybeSingle();
    if (error) throw new Error(`failed to read ALIYUN_SMS_CONFIG: ${error.message}`);
    const value = data?.value;
    if (!value || !value.accessKeyId || !value.accessKeySecret || !value.signName || !value.templates) {
      throw new Error(`ALIYUN_SMS_CONFIG missing/incomplete for org ${orgId}`);
    }
    return value as DysmsConfig;
  }

  return async function sendSms({ phone, code, orgId }: { phone: string; code: string; orgId: string }) {
    const cfg = await getSmsConfig(orgId);
    const templateCode = cfg.templates[VERIFY_TEMPLATE_KEY];
    if (!templateCode) {
      throw new Error(`SMS template '${VERIFY_TEMPLATE_KEY}' not found for org ${orgId}`);
    }
    const client = createDysmsClient(cfg.accessKeyId, cfg.accessKeySecret);
    const req = new SendSmsRequest({
      phoneNumbers: phone,
      signName: cfg.signName,
      templateCode,
      templateParam: JSON.stringify({ code }),
    });
    const res = await client.sendSmsWithOptions(req, {});
    if (res.body?.code !== "OK") {
      throw new Error(`SMS send failed: ${res.body?.code} ${res.body?.message}`);
    }
  };
}
