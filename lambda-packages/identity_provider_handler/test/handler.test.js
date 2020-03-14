'use strict';

const AWS = require('aws-sdk-mock');
const LambdaTester = require('lambda-tester').noVersionCheck();
const sinon = require('sinon');
const handler = require('..');
const nock = require('nock');
const ResponseURL = 'https://iam-response-mock.example.com/';

AWS.setSDK(require.resolve('aws-sdk'));

describe('OIDC Identity Provider Handler', () => {
  const origLog = console.log;
  const origErr = console.error;
  const testRequestId = 'f4ef1b10-c39a-44e3-99c0-fbf7e53c3943';
  const testClusterName = 'test';
  const testNewClusterName = 'test2';
  const testClusterOIDCIssuerURL = 'https://oidc.eks.us-east-1.amazonaws.com/id/EBAABEEF';
  const testNewClusterOIDCIssuerURL = 'https://oidc.eks.us-east-1.amazonaws.com/id/ABCDEF';
  const testOIDCProviderArn = 'arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EBAABEEF';
  const testNewOIDCProviderArn = 'arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABCDEF';

  beforeEach(() => {
    handler.withDefaultResponseURL(ResponseURL);
    console.log = console.error = function () { };
  });
  afterEach(() => {
    // Restore waiters and logger
    AWS.restore();
    console.log = origLog;
    console.error = origErr;
  });

  test('Empty event payload fails', () => {
    const request = nock(ResponseURL).put('/', body => {
      return body.Status === 'FAILED' && body.Reason === 'Unsupported request type undefined';
    }).reply(200);
    return LambdaTester(handler.handler)
      .event({})
      .expectResolve(() => {
        expect(request.isDone()).toBe(true);
      });
  });

  test('Bogus operation fails', () => {
    const bogusType = 'bogus';
    const request = nock(ResponseURL).put('/', body => {
      return body.Status === 'FAILED' && body.Reason === 'Unsupported request type ' + bogusType;
    }).reply(200);
    return LambdaTester(handler.handler)
      .event({
        RequestType: bogusType
      })
      .expectResolve(() => {
        expect(request.isDone()).toBe(true);
      });
  });

  test('Create operation creates an OIDC Provider', () => {
    const describeClusterFake = sinon.fake.resolves({
      cluster: {
        identity: {
          oidc: {
            issuer: testClusterOIDCIssuerURL
          }
        }
      }
    });

    const createProviderFake = sinon.fake.resolves({
      OpenIDConnectProviderArn: testOIDCProviderArn
    });

    AWS.mock('EKS', 'describeCluster', describeClusterFake);
    AWS.mock('IAM', 'createOpenIDConnectProvider', createProviderFake);

    const request = nock(ResponseURL).put('/', body => {
      return body.Status === 'SUCCESS';
    }).reply(200);

    return LambdaTester(handler.handler)
      .event({
        RequestType: 'Create',
        RequestId: testRequestId,
        ResourceProperties: {
          ClusterName: testClusterName
        }
      }).expectResolve(() => {
        sinon.assert.calledWith(describeClusterFake, sinon.match({
          name: testClusterName
        }));
        sinon.assert.calledWith(createProviderFake, sinon.match({
          Url: testClusterOIDCIssuerURL,
          ThumbprintList: [handler.eksOIDCCAThumbprint],
          ClientIDList: ['sts.amazon.com']
        }));
        expect(request.isDone()).toBe(true);
      });
  });

  test('Delete operation deletes the OIDC Provider', () => {
    const deleteProviderFake = sinon.fake.resolves();

    AWS.mock('IAM', 'deleteOpenIDConnectProvider', deleteProviderFake);

    const request = nock(ResponseURL).put('/', body => {
      return body.Status === 'SUCCESS';
    }).reply(200);

    return LambdaTester(handler.handler)
      .event({
        RequestType: 'Delete',
        RequestId: testRequestId,
        PhysicalResourceId: testOIDCProviderArn
      }).expectResolve(() => {
        sinon.assert.calledWith(deleteProviderFake, sinon.match({
          OpenIDConnectProviderArn: testOIDCProviderArn
        }));
        expect(request.isDone()).toBe(true);
      });
  });

  test('Update operation replaces the OIDC Provider', () => {
    const describeClusterFake = sinon.fake.resolves({
      cluster: {
        identity: {
          oidc: {
            issuer: testNewClusterOIDCIssuerURL
          }
        }
      }
    });

    const createProviderFake = sinon.fake.resolves({
      OpenIDConnectProviderArn: testNewOIDCProviderArn
    });

    AWS.mock('EKS', 'describeCluster', describeClusterFake);
    AWS.mock('IAM', 'createOpenIDConnectProvider', createProviderFake);

    const deleteProviderFake = sinon.fake.resolves();

    AWS.mock('IAM', 'deleteOpenIDConnectProvider', deleteProviderFake);

    const request = nock(ResponseURL).put('/', body => {
      return body.Status === 'SUCCESS';
    }).reply(200);

    return LambdaTester(handler.handler)
      .event({
        RequestType: 'Update',
        RequestId: testRequestId,
        PhysicalResourceId: testOIDCProviderArn,
        ResourceProperties: {
          ClusterName: testNewClusterName
        }
      }).expectResolve(() => {
        sinon.assert.calledWith(deleteProviderFake, sinon.match({
          OpenIDConnectProviderArn: testOIDCProviderArn
        }));
        sinon.assert.calledWith(describeClusterFake, sinon.match({
          name: testNewClusterName
        }));
        sinon.assert.calledWith(createProviderFake, sinon.match({
          Url: testNewClusterOIDCIssuerURL,
          ThumbprintList: [handler.eksOIDCCAThumbprint],
          ClientIDList: ['sts.amazon.com']
        }));
        expect(request.isDone()).toBe(true);
      });
  });
});
