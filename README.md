# Amazon EKS IAM Role for Service Accounts CDK/CloudFormation Library

This repository contains an [AWS
CloudFormation](https://aws.amazon.com/cloudformation/) [Custom
Resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources.html)
that creates an [AWS IAM
Role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) that is
assumable by a [Kubernetes Service
Account](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/).
This role is known as an IRSA, or [IAM Role for Service
Account](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html).
This role can be associated with an [Amazon EKS](https://aws.amazon.com/eks/)
Cluster that you're creating in the same CloudFormation stack.  Alternatively,
the EKS Cluster can be created in a different stack and referenced by name.

For ease of implementation, this repository also contains a [CDK
Construct](https://docs.aws.amazon.com/cdk/latest/guide/constructs.html) library
you can import and use to easily create a Role.  This is the quickest and most
programmatic way to build the Role.

Alternatively, a SAM Template is available that you can use to deploy the Custom
Resource Lambda Functions to your account and reference in your YAML or JSON
CloudFormation templates.

## CDK Construct Library usage

Install the Construct Library into your TypeScript project as follows:

```sh
npm install amazon-eks-irsa-cfn
```

In your source code, import the Construct classes:

```typescript
import { Role, OIDCIdentityProvider } from 'amazon-eks-irsa-cfn';
```

Then declare the Constructs in your CDK Stack or Construct. The `Role` class
implements `IRole` and can be used anywhere an `IRole` is needed.

See also
https://docs.aws.amazon.com/cdk/api/latest/docs/@aws-cdk_aws-iam.Role.html for a
list of additional properties that can be supplied when instantiating a `Role`.


```typescript
const provider = new OIDCIdentityProvider(this, 'Provider', {
    clusterName: 'MyCluster'
});

const role = new Role(this, 'Role', {
    clusterName: 'MyCluster',
    serviceAccount: 'myServiceAccount',
    namespace: 'default',
    // All other properties available in an `aws-iam.Role` class are available
    // e.g. `path`, `maxSessionDuration`, `description`, etc.
});
```

## SAM Template and CloudFormation Custom Resources

There is a SAM Template located in the [`lambda-packages`](lambda-packages/)
folder.  It also properly associates the IAM Policies needed for the Lambda
functions to execute properly.

To deploy it, you can run:

```
sam build
sam deploy
```

The Stack that is created by the Template exports the following values:

* `EKSIRSARoleCreationFunction` - Role creation Lambda function ARN
* `OIDCIdentityProviderCreationFunction` - OIDC identity provider creation Lambda function ARN

Once you've deployed the package, you can refer to the Lambda
functions in your CloudFormation Stacks.

Here's an example Stack fragment that uses these functions to power
Custom Resources:

```yaml
Resources:
    MyIdentityProvider:
        Type: Custom::OIDCIdentityProvider
        Properties:
            ServiceToken: !ImportValue OIDCIdentityProviderCreationFunction
            ClusterName: MyCluster

    MyRole:
        Type: Custom::ServiceAccountRole
        Properties:
            ServiceToken: !ImportValue EKSIRSARoleCreationFunction
            ClusterName: MyCluster
            ServiceAccount: myServiceAccount
            # All other properties supported by AWS::IAM::Role can be
            # added here, like Description, Policies, etc.
```

## License

This project is licensed under the Apache-2.0 License.
