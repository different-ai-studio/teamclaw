import STS20150401, * as $STS from "@alicloud/sts20150401";
import OpenApi, * as $OpenApi from "@alicloud/openapi-client";
import {
  ACCESS_KEY_ID,
  ACCESS_KEY_SECRET,
  OSS_BUCKET as BUCKET,
} from "./oss.js";

// ---------------------------------------------------------------------------
// Alibaba STS client + per-role OSS access policies.
//
// Extracted from admin-handlers.ts. `assumeRole` mints scoped, short-lived OSS
// credentials for a team node; the policy builders below describe what each
// role (member / editor / manager / owner) may read and write under
// `teams/<id>/...`.
//
// IDENTITY: the per-node seed used for OSS ACL paths is the member/agent
// **actor_id** (sent on the wire as `actorId`, legacy `nodeId` accepted).
// ---------------------------------------------------------------------------

const ROLE_ARN = () => process.env.ROLE_ARN;

export function getStsClient() {
  const config = new $OpenApi.Config({
    accessKeyId: ACCESS_KEY_ID(),
    accessKeySecret: ACCESS_KEY_SECRET(),
  });
  config.endpoint = "sts.aliyuncs.com";
  return new STS20150401.default(config);
}

export function memberPolicy(teamId: string, nodeId: string) {
  return JSON.stringify({
    Version: "1",
    Statement: [
      {
        Effect: "Allow",
        Action: ["oss:GetObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:ListObjects"],
        Resource: `acs:oss:*:*:${BUCKET()}`,
        Condition: { StringLike: { "oss:Prefix": [`teams/${teamId}/*`] } },
      },
      {
        Effect: "Deny",
        Action: ["oss:GetObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_registry/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:PutObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/updates/${nodeId}/*`,
      },
      {
        Effect: "Allow",
        Action: ["oss:PutObject"],
        Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/signal/${nodeId}/*`,
      },
    ],
  });
}

export function editorPolicy(teamId: string, nodeId: string) {
  const base = JSON.parse(memberPolicy(teamId, nodeId));
  base.Statement.push(
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshots/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/generation.json`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/updates/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshots/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshot/*`,
    }
  );
  return JSON.stringify(base);
}

export function managerPolicy(teamId: string, nodeId: string) {
  const base = JSON.parse(editorPolicy(teamId, nodeId));
  base.Statement.push({
    Effect: "Allow",
    Action: ["oss:PutObject"],
    Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_meta/*`,
  });
  return JSON.stringify(base);
}

export function ownerPolicy(teamId: string, nodeId: string) {
  const base = JSON.parse(memberPolicy(teamId, nodeId));
  base.Statement.push(
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/_meta/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshots/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/snapshot/*`,
    },
    {
      Effect: "Allow",
      Action: ["oss:PutObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*/generation.json`,
    },
    {
      Effect: "Allow",
      Action: ["oss:DeleteObject"],
      Resource: `acs:oss:*:*:${BUCKET()}/teams/${teamId}/*`,
    }
  );
  return JSON.stringify(base);
}

export async function assumeRole(sessionName: string, policy: string) {
  const client = getStsClient();
  const request = new $STS.AssumeRoleRequest({
    roleArn: ROLE_ARN(),
    roleSessionName: sessionName,
    durationSeconds: 3600,
    policy,
  });
  const resp = await client.assumeRole(request);
  const creds = resp.body.credentials!;
  return {
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    securityToken: creds.securityToken,
    expiration: creds.expiration,
  };
}
