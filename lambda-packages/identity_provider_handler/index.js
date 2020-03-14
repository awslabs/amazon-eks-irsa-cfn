'use strict';

const aws = require('aws-sdk');

const eksOIDCCAThumbprint = exports.eksOIDCCAThumbprint = '9e99a48a9960b14926bb7f3b02e22da2b0ab7280';

// These are used for test purposes only
let defaultResponseURL;

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

const getIssuerUrl = async function (clusterName) {
  const eks = new aws.EKS();
  const {
    cluster
  } = await eks.describeCluster({
    name: clusterName
  }).promise();
  return cluster.identity.oidc.issuer;
};

const createProvider = async function (url) {
  const iam = new aws.IAM();

  console.log('Creating identity provider...');
  const provider = await iam.createOpenIDConnectProvider({
    Url: url,
    // hard-coding this for now to be safe - this is the certificate
    // thumbprint for the EKS OIDC endpoint CA
    ThumbprintList: [eksOIDCCAThumbprint],
    ClientIDList: ['sts.amazon.com']
  }).promise();
  return provider.OpenIDConnectProviderArn;
};

const deleteProvider = async function (providerArn) {
  const iam = new aws.IAM();

  console.log(`Deleting provider ${providerArn}...`);
  try {
    await iam.deleteOpenIDConnectProvider({
      OpenIDConnectProviderArn: providerArn
    }).promise();
  } catch (err) {
    console.error(err);
    // if (err.name !== 'ResourceNotFoundException') {
    //    throw err;
    // }
  }
};

/**
 * Main handler, invoked by Lambda
 */
exports.handler = async function (event, context) {
  const responseData = {};
  let physicalResourceId;
  let issuerUrl;

  if (process.stdout._handle) process.stdout._handle.setBlocking(true);
  if (process.stderr._handle) process.stderr._handle.setBlocking(true);

  try {
    switch (event.RequestType) {
      case 'Update':
        await deleteProvider(event.PhysicalResourceId);
        // no break here - fallthrough to create
      case 'Create':
        issuerUrl = await getIssuerUrl(event.ResourceProperties.ClusterName);
        responseData.Arn = physicalResourceId = await createProvider(issuerUrl);
        break;
      case 'Delete':
        physicalResourceId = event.PhysicalResourceId;
        await deleteProvider(physicalResourceId);
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

exports.withDefaultResponseURL = function (url) {
  defaultResponseURL = url;
};
