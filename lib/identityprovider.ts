import { Construct, Duration, Resource, Token } from '@aws-cdk/core';
import { CustomResource, CustomResourceProvider } from '@aws-cdk/aws-cloudformation';
import { PolicyStatement } from '@aws-cdk/aws-iam';
import { Function, Code, Runtime } from '@aws-cdk/aws-lambda';
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

        const provider = new CustomResource(this, 'Resource', {
            provider: CustomResourceProvider.fromLambda(OIDCIdentityProvider.fn),
            resourceType: 'Custom::EksOidcIdentityProvider',
            properties: {
                ClusterName: props.clusterName,
            }
        });
        this.providerArn = Token.asString(provider.getAtt('Arn'));
    }
}
