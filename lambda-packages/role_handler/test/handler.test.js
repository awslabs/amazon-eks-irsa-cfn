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
  const testPolicy2 = {
    PolicyName: 'Test Policy 2',
    PolicyDocument: testPolicy.PolicyDocument
  };
  const testManagedPolicyArn = 'arn:aws:iam::aws:policy/AdministratorAccess';
  const testManagedPolicyArn2 = 'arn:aws:iam::aws:policy/AmazonS3FullAccess';
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
        sinon.assert.calledWith(attachRolePolicyFake, sinon.match({
          RoleName: testRoleName,
          PolicyArn: testManagedPolicyArn,
        }));
        expect(request.isDone()).toBe(true);
      });
  });

  test('Update operation updates an existing Role', () => {
    const updateRoleFake = sinon.fake.resolves();
    const getRoleFake = sinon.fake.resolves({
      Role: {
        RoleName: testRoleName
      }
    });
    const putRolePolicyFake = sinon.fake.resolves();
    const deleteRolePolicyFake = sinon.fake.resolves();
    const attachRolePolicyFake = sinon.fake.resolves();
    const detachRolePolicyFake = sinon.fake.resolves();

    AWS.mock('IAM', 'updateRole', updateRoleFake);
    AWS.mock('IAM', 'getRole', getRoleFake);
    AWS.mock('IAM', 'putRolePolicy', putRolePolicyFake);
    AWS.mock('IAM', 'deleteRolePolicy', deleteRolePolicyFake);
    AWS.mock('IAM', 'attachRolePolicy', attachRolePolicyFake);
    AWS.mock('IAM', 'detachRolePolicy', detachRolePolicyFake);

    const request = nock(ResponseURL).put('/', body => {
      return body.Status === 'SUCCESS';
    }).reply(200);

    return LambdaTester(handler.handler)
      .event({
        RequestType: 'Update',
        RequestId: testRequestId,
        PhysicalResourceId: testRoleName,
        ResourceProperties: {
          ClusterName: testClusterName,
          RoleName: testRoleName,
          Description: testDescription,
          MaxSessionDuration: testMaxSessionDuration,
          Policies: [testPolicy2],
          ManagedPolicyArns: [testManagedPolicyArn2],
          Namespace: testNamespace,
          ServiceAccount: testServiceAccount
        },
        OldResourceProperties: {
          RoleName: testRoleName,
          Policies: [testPolicy],
          ManagedPolicyArns: [testManagedPolicyArn],
        }
      }).expectResolve(() => {
        sinon.assert.calledWith(getRoleFake, {
          RoleName: testRoleName
        });
        sinon.assert.calledWith(updateRoleFake, {
          RoleName: testRoleName,
          MaxSessionDuration: testMaxSessionDuration,
          Description: testDescription
        });
        sinon.assert.calledWith(deleteRolePolicyFake, sinon.match({
          RoleName: testRoleName,
          PolicyName: testPolicy.PolicyName
        }));
        sinon.assert.calledWith(putRolePolicyFake, sinon.match({
          RoleName: testRoleName,
          PolicyName: testPolicy2.PolicyName,
          PolicyDocument: testPolicy2.PolicyDocument
        }));
        sinon.assert.calledWith(detachRolePolicyFake, sinon.match({
          RoleName: testRoleName,
          PolicyArn: testManagedPolicyArn,
        }));
        sinon.assert.calledWith(attachRolePolicyFake, sinon.match({
          RoleName: testRoleName,
          PolicyArn: testManagedPolicyArn2,
        }));
        expect(request.isDone()).toBe(true);
      });
  });

  test('Delete operation deletes the IAM Role', () => {
    const deleteRoleFake = sinon.fake.resolves();
    const detachRolePolicyFake = sinon.fake.resolves();

    AWS.mock('IAM', 'deleteRole', deleteRoleFake);
    AWS.mock('IAM', 'detachRolePolicy', detachRolePolicyFake);

    const request = nock(ResponseURL).put('/', body => {
      return body.Status === 'SUCCESS';
    }).reply(200);

    return LambdaTester(handler.handler)
      .event({
        RequestType: 'Delete',
        RequestId: testRequestId,
        PhysicalResourceId: testRoleName,
        ResourceProperties: {
          ManagedPolicyArns: [testManagedPolicyArn],
        }
      }).expectResolve(() => {
        sinon.assert.calledWith(deleteRoleFake, sinon.match({
          RoleName: testRoleName
        }));
        sinon.assert.calledWith(detachRolePolicyFake, sinon.match({
          RoleName: testRoleName,
          PolicyArn: testManagedPolicyArn
        }));
        expect(request.isDone()).toBe(true);
      });
  });
});
