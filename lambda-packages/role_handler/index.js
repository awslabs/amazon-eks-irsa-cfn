'use strict';

const aws = require('aws-sdk');

const maxRoleNameLen = 63;
const randomSuffixLen = 12;
const maxTruncatedRoleNameLen = maxRoleNameLen - randomSuffixLen - 1;
const suffixChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// These are used for test purposes only
let defaultResponseURL;
let waiter;

/**
 * Upload a CloudFormation response object to S3.
 *
 * @param {object} event the Lambda event payload received by the handler function
 * @param {object} context the Lambda context received by the handler function
 * @param {string} responseStatus the response status, either 'SUCCESS' or 'FAILED'
 * @param {string} physicalResourceId CloudFormation physical resource ID
 * @param {object} [responseData] arbitrary response data object
 * @param {string} [reason] reason for failure, if any, to convey to the user
 * @returns {Promise} Promise that is resolved on success, or rejected on connection error or HTTP error response
 */
const report = function (event, context, responseStatus, physicalResourceId, responseData, reason) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const {
      URL
    } = require('url');

    const responseBody = JSON.stringify({
      Status: responseStatus,
      Reason: reason,
      PhysicalResourceId: physicalResourceId || context.logStreamName,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: responseData
    });

    const parsedUrl = new URL(event.ResponseURL || defaultResponseURL);
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'PUT',
      headers: {
        'Content-Type': '',
        'Content-Length': responseBody.length
      }
    };

    https.request(options)
      .on('error', reject)
      .on('response', res => {
        res.resume();
        if (res.statusCode >= 400) {
          reject(new Error(`Server returned error ${res.statusCode}: ${res.statusMessage}`));
        } else {
          resolve();
        }
      })
      .end(responseBody, 'utf8');
  });
};

const getAccountId = async function () {
  const sts = new aws.STS();
  const resp = await sts.getCallerIdentity().promise();
  return resp.Account;
};

const getIssuer = async function (clusterName) {
  const eks = new aws.EKS();
  const {
    cluster
  } = await eks.describeCluster({
    name: clusterName
  }).promise();
  return cluster.identity.oidc.issuer.replace(new RegExp('^https?://'), '');
};

const getAssumeRolePolicy = function (accountId, issuer, namespace, serviceAccount) {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: {
        Federated: `arn:aws:iam::${accountId}:oidc-provider/${issuer}`
      },
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: {
        StringEquals: {
          [`${issuer}:sub`]: `system:serviceaccount:${namespace}:${serviceAccount}`,
          [`${issuer}:aud`]: 'sts.amazonaws.com'
        }
      }
    }]
  });
};

const createRole = async function (props) {
  const iam = new aws.IAM();

  if (waiter) {
    // Used by the test suite, since waiters aren't mockable yet
    iam.waitFor = waiter;
  }

  console.log('Creating role...');
  const {
    Role
  } = await iam.createRole({
    AssumeRolePolicyDocument: getAssumeRolePolicy(
      await getAccountId(),
      await getIssuer(props.ClusterName),
      props.Namespace,
      props.ServiceAccount
    ),
    RoleName: props.RoleName,
    Description: props.Description,
    MaxSessionDuration: props.MaxSessionDuration,
    Path: props.Path,
    PermissionsBoundary: props.PermissionsBoundary
    // Tags: ...?
  }).promise();

  console.log('Waiting for IAM role creation to finalize...');
  await iam.waitFor('roleExists', {
    RoleName: Role.RoleName
  }).promise();

  console.log('Attaching role policies...');
  for (const policy of props.Policies || []) {
    await iam.putRolePolicy({
      RoleName: Role.RoleName,
      PolicyName: policy.PolicyName,
      PolicyDocument: policy.PolicyDocument
    }).promise();
  }
  for (const arn of props.ManagedPolicyArns || []) {
    await iam.attachRolePolicy({
      RoleName: Role.RoleName,
      PolicyArn: arn
    }).promise();
  }
  return Role;
};

const generateRoleName = exports.generateRoleName = function (logicalResourceId) {
  let roleName = logicalResourceId.substr(0, maxTruncatedRoleNameLen) + '-';
  for (let i = 0; i < randomSuffixLen; i++) {
    roleName = roleName + suffixChars[Math.floor(Math.random() * suffixChars.length)];
  }
  return roleName;
};

const deleteRole = async function (roleName) {
  const iam = new aws.IAM();

  console.log(`Deleting role ${roleName}...`);
  try {
    await iam.deleteRole({
      RoleName: roleName
    }).promise();
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') {
      throw err;
    }
  }
};

/**
 * Main handler, invoked by Lambda
 */
exports.handler = async function (event, context) {
  const responseData = {};
  let physicalResourceId;
  let role;

  if (process.stdout._handle) process.stdout._handle.setBlocking(true);
  if (process.stderr._handle) process.stderr._handle.setBlocking(true);

  try {
    switch (event.RequestType) {
      case 'Create':
        if (!event.ResourceProperties.RoleName) {
          event.ResourceProperties.RoleName = generateRoleName(event.LogicalResourceId);
        }
        role = await createRole(event.ResourceProperties);
        responseData.Arn = role.Arn;
        responseData.RoleId = role.RoleId;
        physicalResourceId = role.RoleName;
        break;
        // TODO
        //          case 'Update':
        //            responseData.Arn = physicalResourceId = certificateArn;
        //            break;
      case 'Delete':
        physicalResourceId = event.PhysicalResourceId;
        await deleteRole(physicalResourceId);
        break;
      default:
        throw new Error(`Unsupported request type ${event.RequestType}`);
    }

    console.log('Uploading SUCCESS response to S3...');
    await report(event, context, 'SUCCESS', physicalResourceId, responseData);
  } catch (err) {
    console.error(`Caught error ${err}. Uploading FAILED message to S3.`);
    await report(event, context, 'FAILED', physicalResourceId, null, err.message);
  }
};

/**
 * @private
 */
exports.withDefaultResponseURL = function (url) {
  defaultResponseURL = url;
};

/**
 * @private
 */
exports.withWaiter = function (w) {
  waiter = w;
};

/**
 * @private
 */
exports.resetWaiter = function () {
  waiter = undefined;
};
