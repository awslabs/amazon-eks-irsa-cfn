'use strict';

const AWS = require('aws-sdk-mock');
const LambdaTester = require('lambda-tester').noVersionCheck();
const sinon = require('sinon');
const handler = require('..');
const nock = require('nock');
const ResponseURL = 'https://iam-response-mock.example.com/';
const maxRoleNameLen = 63;

AWS.setSDK(require.resolve('aws-sdk'));

describe('IAM Role Resource Handler', () => {
  const origLog = console.log;
  const origErr = console.error;
  const testLogicalResourceId = 'TestRoleResource';
  const testDescription = 'This is my role';
  const testRequestId = 'f4ef1b10-c39a-44e3-99c0-fbf7e53c3943';
  const testClusterName = 'testCluster';
  const testRoleName = 'testRole';
  const testMaxSessionDuration = 300;
  const testPath = '/';
  const testAccountId = '123456789012';
  const testPermissionsBoundary = 'arn:aws:iam::aws:policy/ReadOnlyAccess';
  const testPolicy = {
    PolicyName: 'Test Policy',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Action: '*',
        Resource: '*'
      }]
    })
  };
  const testManagedPolicyArn = 'arn:aws:iam::aws:policy/AdministratorAccess';
  const testClusterOIDCIssuerURL = 'https://oidc.eks.us-east-1.amazonaws.com/id/EBAABEEF';
  const testIssuer = testClusterOIDCIssuerURL.replace(new RegExp('^https?://'), '');
  const testServiceAccount = 'testServiceAccount';
  const testNamespace = 'testNamespace';

  beforeEach(() => {
    handler.withDefaultResponseURL(ResponseURL);
    handler.withWaiter(function () {
      // Mock waiter is merely a self-fulfilling promise
      return {
        promise: () => {
          return new Promise((resolve) => {
            resolve();
          });
        }
      };
    });
    // handler.withSleep(spySleep);
    console.log = console.error = function () {};
  });
  afterEach(() => {
    // Restore waiters and logger
    AWS.restore();
    handler.resetWaiter();
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

  test('Role name generator', () => {
    const roleName = handler.generateRoleName(testLogicalResourceId);
    expect(roleName.length).toBeLessThanOrEqual(maxRoleNameLen);
    expect(roleName).toMatch(/^[A-Za-z]+-[A-Z0-9]+$/);
  });

  test('Create operation creates a new Role', () => {
    const createRoleFake = sinon.fake.resolves({
      Role: {
        RoleName: testRoleName
      }
    });
    const getRoleFake = sinon.stub();
    getRoleFake.onFirstCall().rejects();
    getRoleFake.resolves();
    const putRolePolicyFake = sinon.fake.resolves();
    const attachRolePolicyFake = sinon.fake.resolves();
    const getCallerIdentityFake = sinon.fake.resolves({
      Account: testAccountId
    });
    const describeClusterFake = sinon.fake.resolves({
      cluster: {
        identity: {
          oidc: {
            issuer: testClusterOIDCIssuerURL
          }
        }
      }
    });

    AWS.mock('IAM', 'createRole', createRoleFake);
    AWS.mock('IAM', 'putRolePolicy', putRolePolicyFake);
    AWS.mock('IAM', 'attachRolePolicy', attachRolePolicyFake);
    AWS.mock('STS', 'getCallerIdentity', getCallerIdentityFake);
    AWS.mock('EKS', 'describeCluster', describeClusterFake);

    const request = nock(ResponseURL).put('/', body => {
      return body.Status === 'SUCCESS';
    }).reply(200);

    return LambdaTester(handler.handler)
      .event({
        RequestType: 'Create',
        RequestId: testRequestId,
        LogicalResourceId: testLogicalResourceId,
        ResourceProperties: {
          ClusterName: testClusterName,
          RoleName: testRoleName,
          Description: testDescription,
          MaxSessionDuration: testMaxSessionDuration,
          Path: testPath,
          PermissionsBoundary: testPermissionsBoundary,
          Policies: [testPolicy],
          ManagedPolicyArns: [testManagedPolicyArn],
          Namespace: testNamespace,
          ServiceAccount: testServiceAccount
        }
      }).expectResolve(() => {
        sinon.assert.called(getCallerIdentityFake);
        sinon.assert.calledWith(describeClusterFake, {
          name: testClusterName
        });
        sinon.assert.calledWith(createRoleFake, sinon.match({
          AssumeRolePolicyDocument: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: {
                Federated: `arn:aws:iam::${testAccountId}:oidc-provider/${testIssuer}`
              },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  [`${testIssuer}:sub`]: `system:serviceaccount:${testNamespace}:${testServiceAccount}`,
                  [`${testIssuer}:aud`]: 'sts.amazonaws.com'
                }
              }
            }]
          }),
          RoleName: testRoleName,
          Description: testDescription,
          MaxSessionDuration: testMaxSessionDuration,
          Path: testPath,
          PermissionsBoundary: testPermissionsBoundary
        }));
        sinon.assert.calledWith(putRolePolicyFake, sinon.match({
          RoleName: testRoleName,
          PolicyName: testPolicy.PolicyName,
          PolicyDocument: testPolicy.PolicyDocument
        }));
        sinon.assert.calledWith(putRolePolicyFake, sinon.match({
          RoleName: testRoleName,
          PolicyName: testPolicy.PolicyName,
          PolicyDocument: testPolicy.PolicyDocument
        }));
        expect(request.isDone()).toBe(true);
      });
  });

  test('Delete operation deletes the IAM Role', () => {
    const deleteRoleFake = sinon.fake.resolves();

    AWS.mock('IAM', 'deleteRole', deleteRoleFake);

    const request = nock(ResponseURL).put('/', body => {
      return body.Status === 'SUCCESS';
    }).reply(200);

    return LambdaTester(handler.handler)
      .event({
        RequestType: 'Delete',
        RequestId: testRequestId,
        PhysicalResourceId: testRoleName
      }).expectResolve(() => {
        sinon.assert.calledWith(deleteRoleFake, sinon.match({
          RoleName: testRoleName
        }));
        expect(request.isDone()).toBe(true);
      });
  });
});
