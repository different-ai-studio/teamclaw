# Spike: `@alicloud/fc20230330` API surface for per-app FC provisioning

Status: M0 research spike (no implementation). Phase-2 (M2) will provision a
per-app Alibaba Function Compute (FC 3.0) function from this `services/fc`
codebase.

- **SDK added:** `@alicloud/fc20230330@4.7.6` (installed; pinned `^4.7.6` in
  `services/fc/package.json`).
- **Package manager:** `npm` (the lockfile in `services/fc/` is
  `package-lock.json`, not `pnpm-lock.yaml`). Run from inside `services/fc`.
- **Ground truth:** all names/signatures below are quoted from the installed
  `node_modules/@alicloud/fc20230330/dist/**/*.d.ts`. Anything from docs (not
  types) is explicitly labeled.

Existing pattern reference: `services/fc/src/lib/oss.ts` builds an Alibaba S3/OSS
client from env (`ACCESS_KEY_ID`, `ACCESS_KEY_SECRET`, `REGION`, `ENDPOINT`,
plus `ROLE_ARN` used elsewhere). We mirror that env style below.

---

## 1. Client construction

The exported class is **`Client`** (default export):

```ts
// node_modules/@alicloud/fc20230330/dist/client.d.ts
export default class Client extends OpenApi {
    constructor(config: $OpenApiUtil.Config);
    ...
}
```

The constructor wants a `Config`. The fc client's declared type is
`$OpenApiUtil.Config` (from `@alicloud/openapi-core`), but
`@alicloud/openapi-client` — already a direct dependency of `services/fc`
(`"@alicloud/openapi-client": "^0.4.12"`) — exports a `Config` class with the
identical field set (both extend the Darabonba tea `Model`). Use the
openapi-client one to match the rest of the Alibaba SDK ecosystem.

```ts
import FcClient from "@alicloud/fc20230330";
import { Config } from "@alicloud/openapi-client";

// env helpers (mirror services/fc/src/lib/oss.ts)
const REGION = () => process.env.REGION || "cn-hangzhou";

export function getFcClient(): FcClient {
  return new FcClient(
    new Config({
      accessKeyId: process.env.ACCESS_KEY_ID!,
      accessKeySecret: process.env.ACCESS_KEY_SECRET!,
      regionId: REGION(),
      // FC 3.0 regional endpoint format: <accountId>.<region>.fc.aliyuncs.com
      // i.e. it is ACCOUNT-SPECIFIC for the data-plane. The classic
      // <region>.fc.aliyuncs.com host is the legacy 2.0 console host.
      endpoint: process.env.FC_ENDPOINT
        || `${process.env.ALIYUN_ACCOUNT_ID}.${REGION()}.fc.aliyuncs.com`,
    }),
  );
}
```

`Config` fields available (from
`node_modules/@alicloud/openapi-core/.../utils.d.ts` `class Config`): include
`accessKeyId?`, `accessKeySecret?`, `securityToken?`, `regionId?`, `endpoint?`,
`protocol?`, `readTimeout?`, `connectTimeout?`, `userAgent?`, `endpointType?`,
`signatureVersion?`, `credential?`, etc. — all optional.

**Endpoint format (to-verify-live, see §7):** FC 3.0's data-plane host is
account-scoped: `<accountId>.<region>.fc.aliyuncs.com`. The existing `ENDPOINT`
env in `oss.ts` is an **OSS** endpoint and must NOT be reused for FC. Introduce a
separate `FC_ENDPOINT` (or compose from `ALIYUN_ACCOUNT_ID` + `REGION`).

---

## 2. CreateFunction (custom-runtime HTTP function from OSS code)

Method + request (quoted):

```ts
// client.d.ts
createFunction(request: $_model.CreateFunctionRequest): Promise<$_model.CreateFunctionResponse>;
// with options:
createFunctionWithOptions(request, headers, runtime): Promise<CreateFunctionResponse>;
```

`CreateFunctionRequest` wraps the body:

```ts
// models/CreateFunctionRequest.d.ts
export declare class CreateFunctionRequest extends $dara.Model {
    body?: CreateFunctionInput;   // "This parameter is required."
}
```

`CreateFunctionInput` (relevant fields, all quoted from
`models/CreateFunctionInput.d.ts`):

| Field | Type | Notes (from JSDoc) |
| --- | --- | --- |
| `functionName?` | `string` | **required**; 1–64 chars, `[A-Za-z0-9_-]`, no leading digit/hyphen |
| `runtime?` | `string` | **required**; for custom HTTP use `custom`, `custom.debian10`, or `custom-container` |
| `handler?` | `string` | **required**; e.g. `index.handler` (custom runtime still needs a handler value) |
| `memorySize?` | `number` | MB, multiple of 64, 128–32768; cpu:memGB ratio 1:1–1:4 |
| `cpu?` | `number` | vCPU, multiple of 0.05, 0.05–16 |
| `timeout?` | `number` | seconds, 1–86400, default 3 |
| `diskSize?` | `number` | MB, only `512` or `10240` |
| `role?` | `string` | the RAM role ARN = our `ROLE_ARN` env, e.g. `acs:ram::<acct>:role/fc-test` |
| `environmentVariables?` | `{ [k: string]: string }` | runtime env |
| `customRuntimeConfig?` | `CustomRuntimeConfig` | startup command/args + listening `port` for the HTTP server |
| `code?` | `InputCodeLocation` | code package — "Configure either code or customContainerConfig" |
| `internetAccess?` | `boolean` | default true |
| `description?` | `string` | |

`CustomRuntimeConfig` (for a Node/TanStack HTTP server in `custom` runtime):

```ts
// models/CustomRuntimeConfig.d.ts
export declare class CustomRuntimeConfig extends $dara.Model {
    args?: string[];
    command?: string[];                 // startup command, e.g. ["node", "server.js"]
    healthCheckConfig?: CustomHealthCheckConfig;
    port?: number;                      // port the HTTP server listens on, e.g. 9000
}
```

**Code-from-OSS** — `InputCodeLocation` (exact field names; this answers the
"`InputCodeLocation`/`ossBucketName`/`ossObjectName`" question):

```ts
// models/InputCodeLocation.d.ts
export declare class InputCodeLocation extends $dara.Model {
    checksum?: string;        // CRC-64 of the zip (optional integrity check)
    ossBucketName?: string;   // OSS bucket holding the code ZIP
    ossObjectName?: string;   // OSS object key of the code ZIP
    zipFile?: string;         // OR: base64-encoded zip inline (alternative to OSS)
}
```

So code-from-OSS uses `code.ossBucketName` + `code.ossObjectName` (the same OSS
bucket the `oss.ts` S3 client writes to). `zipFile` is the inline alternative.

Sketch:

```ts
import * as $fc from "@alicloud/fc20230330/dist/models/model"; // models barrel

await fc.createFunction(new $fc.CreateFunctionRequest({
  body: new $fc.CreateFunctionInput({
    functionName,
    runtime: "custom.debian10",
    handler: "index.handler",
    memorySize: 512,
    cpu: 0.5,
    timeout: 60,
    diskSize: 512,
    role: process.env.ROLE_ARN,
    environmentVariables: { /* APPS_DB_URL, etc. */ },
    customRuntimeConfig: new $fc.CustomRuntimeConfig({
      command: ["node", "server.js"],
      port: 9000,
    }),
    code: new $fc.InputCodeLocation({
      ossBucketName: process.env.BUCKET || "teamclaw-sync",
      ossObjectName: `apps/${appId}/code.zip`,
    }),
  }),
}));
```

---

## 3. UpdateFunctionCode / update code pointer

There is **no** dedicated `updateFunctionCode` method in this SDK version. Code
is updated via the general **`updateFunction`**:

```ts
// client.d.ts
updateFunction(functionName: string, request: $_model.UpdateFunctionRequest): Promise<$_model.UpdateFunctionResponse>;
updateFunctionWithOptions(functionName, request, headers, runtime): Promise<UpdateFunctionResponse>;
```

```ts
// models/UpdateFunctionRequest.d.ts
export declare class UpdateFunctionRequest extends $dara.Model {
    body?: UpdateFunctionInput;   // "This parameter is required."
}
```

`UpdateFunctionInput` has the **same `code?: InputCodeLocation`** field as
CreateFunctionInput (plus runtime/handler/memory/timeout/role/env/
customRuntimeConfig). To re-point code at a new OSS object:

```ts
await fc.updateFunction(functionName, new $fc.UpdateFunctionRequest({
  body: new $fc.UpdateFunctionInput({
    code: new $fc.InputCodeLocation({
      ossBucketName: process.env.BUCKET || "teamclaw-sync",
      ossObjectName: `apps/${appId}/code.zip`,
    }),
  }),
}));
```

(`functionName` is a positional argument, not inside the body.)

---

## 4. GetFunction (for check-then-create idempotency)

```ts
// client.d.ts
getFunction(functionName: string, request: $_model.GetFunctionRequest): Promise<$_model.GetFunctionResponse>;
getFunctionWithOptions(functionName, request, headers, runtime): Promise<GetFunctionResponse>;
```

```ts
// models/GetFunctionRequest.d.ts
export declare class GetFunctionRequest extends $dara.Model {
    qualifier?: string;   // version/alias, e.g. "LATEST" — optional
}
```

**"Not found" shape:** the SDK throws on non-2xx. The error body is the `Error`
model:

```ts
// models/Error.d.ts
export declare class Error extends $dara.Model {
    code?: string;      // e.g. "FunctionNotFound"  (JSDoc @example)
    message?: string;   // e.g. "function not found"
    requestId?: string;
}
```

So idempotency = call `getFunction`; if it throws with HTTP **404** and
`code === "FunctionNotFound"`, treat as absent and `createFunction`; otherwise
`updateFunction`. (The thrown error is a Darabonba/tea error; the `code`/
`message`/`statusCode` are surfaced on the thrown object — exact JS property
names to confirm live, see §7.)

---

## 5. CreateTrigger (http) + reading the invoke URL

```ts
// client.d.ts
createTrigger(functionName: string, request: $_model.CreateTriggerRequest): Promise<$_model.CreateTriggerResponse>;
getTrigger(functionName: string, triggerName: string): Promise<$_model.GetTriggerResponse>;
listTriggers(functionName: string, request: $_model.ListTriggersRequest): Promise<$_model.ListTriggersResponse>;
```

```ts
// models/CreateTriggerRequest.d.ts
export declare class CreateTriggerRequest extends $dara.Model { body?: CreateTriggerInput; }

// models/CreateTriggerInput.d.ts (relevant fields)
export declare class CreateTriggerInput extends $dara.Model {
    triggerName?: string;     // required; [A-Za-z0-9_-], 1–128, no leading digit/hyphen
    triggerType?: string;     // required; use "http" for HTTP trigger
    triggerConfig?: string;   // required; JSON STRING. For http it is HTTPTriggerConfig
    qualifier?: string;       // version/alias, e.g. "LATEST"
    invocationRole?: string;
    sourceArn?: string;
    description?: string;
}
```

`triggerConfig` is a **JSON string** (not an object). For HTTP, serialize an
`HTTPTriggerConfig` shape:

```ts
// models/HttptriggerConfig.d.ts  (class HTTPTriggerConfig)
authType?: string;            // "anonymous" (public) | "function" (signed); default "function"
methods?: string[];           // ["GET","POST",...]
disableURLInternet?: boolean;
authConfig?: string;
corsConfig?: CORSConfig;
```

```ts
await fc.createTrigger(functionName, new $fc.CreateTriggerRequest({
  body: new $fc.CreateTriggerInput({
    triggerName: "http",
    triggerType: "http",
    triggerConfig: JSON.stringify({ authType: "anonymous", methods: ["GET","POST","PUT","DELETE"] }),
  }),
}));
```

**Reading the public invoke URL** — it is NOT on the create response body
directly; read it from the trigger via `getTrigger`. `GetTriggerResponse.body`
is a `Trigger`, whose `httpTrigger` holds the URLs:

```ts
// models/Trigger.d.ts
export declare class Trigger extends $dara.Model {
    httpTrigger?: HTTPTrigger;   // present for http triggers
    triggerType?: string;        // "http"
    status?: string;             // "OK"
    triggerName?: string;
    ...
}

// models/Httptrigger.d.ts  (class HTTPTrigger)
urlInternet?: string;   // PUBLIC URL, e.g. https://svc-func-xxxx.<region>.fcapp.run
urlIntranet?: string;   // VPC-internal URL
```

So:

```ts
const t = await fc.getTrigger(functionName, "http");
const publicUrl = t.body?.httpTrigger?.urlInternet;
```

(The `urlInternet` may also appear on the create response's trigger body; rely on
`getTrigger` as the authoritative read — confirm on the create response live,
§7.)

---

## 6. RAM permissions the AK/SK needs

Action strings (FC 3.0 RAM action names) required for the M2 flow:

- `fc:CreateFunction`
- `fc:UpdateFunction`  (this SDK has no UpdateFunctionCode; code update goes
  through UpdateFunction)
- `fc:GetFunction`
- `fc:CreateTrigger`
- `fc:GetTrigger`
- `fc:ListTriggers` (if used)
- Optional cleanup: `fc:DeleteFunction`, `fc:DeleteTrigger`
- `ram:PassRole` on the `ROLE_ARN` passed as `CreateFunctionInput.role`
  (FC assumes that role; without PassRole, CreateFunction fails).
- For code-from-OSS the **function's execution role** (`ROLE_ARN`) — not the
  caller AK/SK — needs `oss:GetObject` on the code bucket/object so FC can pull
  the ZIP. The caller AK/SK that uploads the ZIP needs `oss:PutObject` (already
  covered by the existing OSS path in `oss.ts`).

**FOLLOW-UP (operator):** confirm the production AK/SK used by `services/fc`
actually carries the `fc:*` actions + `ram:PassRole` above, and that `ROLE_ARN`
trusts FC (`fc.aliyuncs.com`) and has `oss:GetObject` on the code bucket. The
existing AK/SK was provisioned for OSS only — FC actions are likely NOT yet
granted.

---

## 7. Open questions / verify-live in M2

1. **FC endpoint host.** Confirm the exact data-plane host. FC 3.0 is
   account-scoped (`<accountId>.<region>.fc.aliyuncs.com`); need the production
   `ALIYUN_ACCOUNT_ID` (or a dedicated `FC_ENDPOINT` env). The `oss.ts` `ENDPOINT`
   env is OSS-only and must not be reused.
2. **`custom` vs `custom.debian10` vs `custom-container`** for the TanStack/Node
   server — pick per the T1 runtime spike; confirm the chosen runtime string is
   accepted (the type lists `custom`, `custom.debian10`, `custom-container`).
3. **Whether `handler` is mandatory for `custom` runtime.** Type marks `handler`
   required at the API level; a placeholder like `index.handler` is typically
   accepted for custom runtime — verify live.
4. **Error object property names on throw.** Types declare the `Error` *body*
   model (`code`/`message`/`requestId`), but the JS exception thrown by the tea
   runtime surfaces these on specific props (commonly `err.code`,
   `err.message`, `err.statusCode`, `err.data.Code`). Confirm the precise shape
   so the 404/`FunctionNotFound` check-then-create branch is reliable.
5. **Create-trigger response URL.** Confirm whether `CreateTriggerResponse.body`
   already carries `httpTrigger.urlInternet`, or whether a follow-up
   `getTrigger` is required (we default to `getTrigger`).
6. **`@alicloud/openapi-client` `Config` vs `@alicloud/openapi-core` `Config`.**
   The fc client constructor types `$OpenApiUtil.Config` (openapi-core). We use
   openapi-client's `Config` (already a dep, same fields). Confirm TS accepts it;
   if strict typing complains, import `Config` from
   `@alicloud/openapi-core`'s util export instead.
7. **Models import path.** Models are re-exported from the client
   (`export * from './models/model'` in `client.d.ts`), so
   `import * as $fc from "@alicloud/fc20230330"` should expose the request
   classes. Confirm the ergonomic import path during implementation.
