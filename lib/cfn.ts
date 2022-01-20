import { Token } from "aws-cdk-lib";

// Borrowed from CfnRole.PolicyProperty
export namespace CfnRole {
    /**
     * @see http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-iam-policy.html
     */
    export interface PolicyProperty {
        /**
         * `CfnRole.PolicyProperty.PolicyDocument`
         * @see http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-iam-policy.html#cfn-iam-policies-policydocument
         */
        readonly policyDocument: object | Token;
        /**
         * `CfnRole.PolicyProperty.PolicyName`
         * @see http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-iam-policy.html#cfn-iam-policies-policyname
         */
        readonly policyName: string;
    }
}
