import { Construct } from 'constructs';
import { CustomResource, Duration, Resource, Token } from 'aws-cdk-lib/core';
import { Provider, ProviderProps } from 'aws-cdk-lib/custom-resources';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function, Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';

export interface OIDCIdentityProviderProps {
    /**
     * The EKS cluster name.
     */
    readonly clusterName: string;
}

export class OIDCIdentityProvider extends Resource {
    /**
     * Returns the ARN of the identity provider.
     *
     * @attribute
     */
    public readonly providerArn: string;

    private static fn: Function;
    constructor(scope: Construct, id: string, props: OIDCIdentityProviderProps) {
        super(scope, id);

        if (!OIDCIdentityProvider.fn) {
            OIDCIdentityProvider.fn = new Function(scope, 'OIDCIdentityProviderCustomResource', {
                code: Code.fromAsset(path.resolve(__dirname, '..', 'lambda-packages', 'identity_provider_handler')),
                handler: 'index.handler',
                runtime: Runtime.NODEJS_12_X,
                timeout: Duration.minutes(15),
            });
            OIDCIdentityProvider.fn.addToRolePolicy(new PolicyStatement({
                actions: [
                    'eks:DescribeCluster',
                    'iam:CreateOpenIDConnectProvider',
                    'iam:DeleteOpenIDConnectProvider'
                ],
                resources: ['*']
            }));
        }

        const provider = new Provider(this, 'OIDCIdentityProvider', {
            onEventHandler: OIDCIdentityProvider.fn
        } as ProviderProps);


        const customResource = new CustomResource(this, 'Resource', {
            serviceToken: provider.serviceToken,
            resourceType: 'Custom::EksOidcIdentityProvider',
            properties: {
                ClusterName: props.clusterName,
            }
        });
        this.providerArn = Token.asString(customResource.getAtt('Arn'));
    }
}
