import { Construct, Duration, Lazy, Resource, Token } from '@aws-cdk/core';
import { Grant, IManagedPolicy, Policy, PolicyDocument, PolicyStatement, ArnPrincipal, IPrincipal, PrincipalPolicyFragment, IRole } from '@aws-cdk/aws-iam';
import { AttachedPolicies } from './util';
import { CustomResource, CustomResourceProvider } from '@aws-cdk/aws-cloudformation';
import { Function, Code, Runtime } from '@aws-cdk/aws-lambda';
import { CfnRole } from './cfn';
import * as path from 'path';


export interface RoleProps {
    /**
     * The EKS cluster name.
     */
    readonly clusterName: string;

    /**
     * The Kubernetes namespace in which the service account lives.
     * @default default
     */
    readonly namespace?: string;

    /**
     * The Kubernetes service account that will be allowed to assume the IAM Role.
     */
    readonly serviceAccount: string;

    /**
     * A list of managed policies associated with this role.
     *
     * You can add managed policies later using
     * `addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName(policyName))`.
     *
     * @default - No managed policies.
     */
    readonly managedPolicies?: IManagedPolicy[];
    /**
     * A list of named policies to inline into this role. These policies will be
     * created with the role, whereas those added by ``addToPolicy`` are added
     * using a separate CloudFormation resource (allowing a way around circular
     * dependencies that could otherwise be introduced).
     *
     * @default - No policy is inlined in the Role resource.
     */
    readonly inlinePolicies?: {
        [name: string]: PolicyDocument;
    };
    /**
     * The path associated with this role. For information about IAM paths, see
     * Friendly Names and Paths in IAM User Guide.
     *
     * @default /
     */
    readonly path?: string;
    /**
     * AWS supports permissions boundaries for IAM entities (users or roles).
     * A permissions boundary is an advanced feature for using a managed policy
     * to set the maximum permissions that an identity-based policy can grant to
     * an IAM entity. An entity's permissions boundary allows it to perform only
     * the actions that are allowed by both its identity-based policies and its
     * permissions boundaries.
     *
     * @link https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html#cfn-iam-role-permissionsboundary
     * @link https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html
     *
     * @default - No permissions boundary.
     */
    readonly permissionsBoundary?: IManagedPolicy;
    /**
     * A name for the IAM role. For valid values, see the RoleName parameter for
     * the CreateRole action in the IAM API Reference.
     *
     * IMPORTANT: If you specify a name, you cannot perform updates that require
     * replacement of this resource. You can perform updates that require no or
     * some interruption. If you must replace the resource, specify a new name.
     *
     * If you specify a name, you must specify the CAPABILITY_NAMED_IAM value to
     * acknowledge your template's capabilities. For more information, see
     * Acknowledging IAM Resources in AWS CloudFormation Templates.
     *
     * @default - AWS CloudFormation generates a unique physical ID and uses that ID
     * for the group name.
     */
    readonly roleName?: string;
    /**
     * The maximum session duration that you want to set for the specified role.
     * This setting can have a value from 1 hour (3600sec) to 12 (43200sec) hours.
     *
     * Anyone who assumes the role from the AWS CLI or API can use the
     * DurationSeconds API parameter or the duration-seconds CLI parameter to
     * request a longer session. The MaxSessionDuration setting determines the
     * maximum duration that can be requested using the DurationSeconds
     * parameter.
     *
     * If users don't specify a value for the DurationSeconds parameter, their
     * security credentials are valid for one hour by default. This applies when
     * you use the AssumeRole* API operations or the assume-role* CLI operations
     * but does not apply when you use those operations to create a console URL.
     *
     * @link https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use.html
     *
     * @default Duration.hours(1)
     */
    readonly maxSessionDuration?: Duration;
    /**
     * A description of the role. It can be up to 1000 characters long.
     *
     * @default - No description.
     */
    readonly description?: string;
}

/**
 * IAM Role
 *
 * Defines an IAM role. The role is created with an assume policy document associated with
 * the specified AWS service principal defined in `serviceAssumeRole`.
 */
export class Role extends Resource implements IRole {

    public readonly grantPrincipal: IPrincipal = this;

    public readonly assumeRoleAction: string = 'sts:AssumeRoleWithWebIdentity';

    /**
     * Returns the ARN of this role.
     */
    public readonly roleArn: string;

    /**
     * Returns the stable and unique string identifying the role. For example,
     * AIDAJQABLZS4A3QDU576Q.
     *
     * @attribute
     */
    public readonly roleId: string;

    /**
     * Returns the name of the role.
     */
    public readonly roleName: string;

    /**
     * Returns the role.
     */
    public readonly policyFragment: PrincipalPolicyFragment;

    /**
     * Returns the permissions boundary attached to this role
     */
    public readonly permissionsBoundary?: IManagedPolicy;

    private defaultPolicy?: Policy;
    private readonly managedPolicies: IManagedPolicy[] = [];
    private readonly attachedPolicies = new AttachedPolicies();

    private static fn: Function;

    constructor(scope: Construct, id: string, props: RoleProps) {
        super(scope, id, {
            physicalName: props.roleName,
        });

        this.managedPolicies.push(...props.managedPolicies || []);
        this.permissionsBoundary = props.permissionsBoundary;
        const maxSessionDuration = props.maxSessionDuration && props.maxSessionDuration.toSeconds();
        validateMaxSessionDuration(maxSessionDuration);
        const description = (props.description && props.description?.length > 0) ? props.description : undefined;

        if (description && description.length > 1000) {
            throw new Error('Role description must be no longer than 1000 characters.');
        }

        if (!Role.fn) {
            Role.fn = new Function(scope, 'IAMRoleForK8SSvcAcctCustomResource', {
                code: Code.fromAsset(path.resolve(__dirname, '..', 'lambda-packages', 'role_handler')),
                handler: 'index.handler',
                runtime: Runtime.NODEJS_12_X,
                timeout: Duration.minutes(15),
            });
            Role.fn.addToRolePolicy(new PolicyStatement({
                actions: [
                    'eks:DescribeCluster',
                    'iam:AttachRolePolicy',
                    'iam:CreateRole',
                    'iam:DeleteRole',
                    'iam:DeleteRolePolicy',
                    'iam:DescribeRole',
                    'iam:DetachRolePolicy',
                    'iam:GetRole',
                    'iam:ListAttachedRolePolicies',
                    'iam:ListRoles',
                    'iam:PutRolePermissionsBoundary',
                    'iam:PutRolePolicy',
                    'iam:TagRole',
                    'iam:UntagRole',
                    'iam:UpdateAssumeRolePolicy',
                    'iam:UpdateRole',
                    'sts:GetCallerIdentity'],
                resources: ['*']
            }));
        }

        const role = new CustomResource(this, 'Resource', {
            provider: CustomResourceProvider.fromLambda(Role.fn),
            resourceType: 'Custom::IamRoleForServiceAccount',
            properties: {
                ClusterName: props.clusterName,
                Namespace: props.namespace || 'default',
                ServiceAccount: props.serviceAccount,
                ManagedPolicyArns: Lazy.listValue({ produce: () => this.managedPolicies.map(p => p.managedPolicyArn) }, { omitEmpty: true }),
                Policies: _flatten(props.inlinePolicies),
                Path: props.path,
                PermissionsBoundary: this.permissionsBoundary ? this.permissionsBoundary.managedPolicyArn : undefined,
                RoleName: this.physicalName,
                MaxSessionDuration: maxSessionDuration,
                Description: description,
            }
        })

        this.roleId = Token.asString(role.getAtt('RoleId'));
        this.roleArn = this.getResourceArnAttribute(Token.asString(role.getAtt('Arn')), {
            region: '', // IAM is global in each partition
            service: 'iam',
            resource: 'role',
            resourceName: this.physicalName,
        });
        this.roleName = this.getResourceNameAttribute(role.ref);
        this.policyFragment = new ArnPrincipal(this.roleArn).policyFragment;

        function _flatten(policies?: { [name: string]: PolicyDocument }) {
            if (policies == null || Object.keys(policies).length === 0) {
                return undefined;
            }
            const result = new Array<CfnRole.PolicyProperty>();
            for (const policyName of Object.keys(policies)) {
                const policyDocument = policies[policyName];
                result.push({ policyName, policyDocument });
            }
            return result;
        }
    }

    /**
     * Adds a permission to the role's default policy document.
     * If there is no default policy attached to this role, it will be created.
     * @param statement The permission statement to add to the policy document
     */
    public addToPolicy(statement: PolicyStatement): boolean {
        if (!this.defaultPolicy) {
            this.defaultPolicy = new Policy(this, 'DefaultPolicy');
            this.attachInlinePolicy(this.defaultPolicy);
        }
        this.defaultPolicy.addStatements(statement);
        return true;
    }

    /**
     * Attaches a managed policy to this role.
     * @param policy The the managed policy to attach.
     */
    public addManagedPolicy(policy: IManagedPolicy) {
        if (this.managedPolicies.find(mp => mp === policy)) { return; }
        this.managedPolicies.push(policy);
    }

    /**
     * Attaches a policy to this role.
     * @param policy The policy to attach
     */
    public attachInlinePolicy(policy: Policy) {
        this.attachedPolicies.attach(policy);
        policy.attachToRole(this);
    }

    /**
     * Grant the actions defined in actions to the identity Principal on this resource.
     */
    public grant(grantee: IPrincipal, ...actions: string[]) {
        return Grant.addToPrincipal({
            grantee,
            actions,
            resourceArns: [this.roleArn],
            scope: this
        });
    }

    /**
     * Grant permissions to the given principal to pass this role.
     */
    public grantPassRole(identity: IPrincipal) {
        return this.grant(identity, 'iam:PassRole');
    }
}


function validateMaxSessionDuration(duration?: number) {
    if (duration === undefined) {
        return;
    }

    if (duration < 3600 || duration > 43200) {
        throw new Error(`maxSessionDuration is set to ${duration}, but must be >= 3600sec (1hr) and <= 43200sec (12hrs)`);
    }
}

/**
 * A PolicyStatement that normalizes its Principal field differently
 *
 * Normally, "anyone" is normalized to "Principal: *", but this statement
 * normalizes to "Principal: { AWS: * }".
 */
class AwsStarStatement extends PolicyStatement {
    public toStatementJson(): any {
        const stat = super.toStatementJson();

        if (stat.Principal === '*') {
            stat.Principal = { AWS: '*' };
        }

        return stat;
    }
}
