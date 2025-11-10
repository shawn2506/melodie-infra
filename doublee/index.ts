import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";


const stack = pulumi.getStack();
const project = pulumi.getProject();
const config = new pulumi.Config("shonry27");
const region = aws.config.region;
const vpcCidr = config.require("vpcCidr");
const callerIdentity = aws.getCallerIdentity();

// Get list of public subnet CIDRs
const publicSubnetCidrs = config.getObject<string[]>("publicSubnetCidrs") || [];
// Example: Print them or pass to a resource
publicSubnetCidrs.forEach((cidr, index) => {
  console.log(`Public Subnet ${index + 1}: ${cidr}`);
});

const vpc = new aws.ec2.Vpc("vpc", {
  cidrBlock: vpcCidr,
  enableDnsSupport: true,
  instanceTenancy: "default",
  tags: {
    Name: `${project}-${stack}-vpc`,
  },
});

const publicSubnets = publicSubnetCidrs.map(
  (cidr, index) =>
    new aws.ec2.Subnet(`pubSub${index + 1}`, {
      vpcId: vpc.id,
      cidrBlock: cidr,
      availabilityZone: `${region}${String.fromCharCode(97 + index)}`, // a, b, c
      tags: {
        Scope: "Public",
        Project: `${project}`,
        Name: `${project}-${stack}-public-${index + 1}`,
      },
    }),
);

const igw = new aws.ec2.InternetGateway("igw", {
  vpcId: vpc.id,
  tags: {
    Scope: "Public",
    Name: `${project}-${stack}-igw`,
    Project: `${project}`,
  },
});

const publicRt = new aws.ec2.RouteTable("publicRt", {
  vpcId: vpc.id,
  routes: [
    {
      cidrBlock: "0.0.0.0/0",
      gatewayId: igw.id,
    },
  ],
  tags: {
    Scope: "Public",
    Name: `${project}-${stack}-public`,
    Project: `${project}`,
  },
});

const publicSubnetAssociations = publicSubnets.map(
  (subnet, index) =>
    new aws.ec2.RouteTableAssociation(`pubSubAsc${index + 1}`, {
      subnetId: subnet.id,
      routeTableId: publicRt.id,
    }),
);

// Security Group
const sg = new aws.ec2.SecurityGroup("secGrp", {
  vpcId: vpc.id,
  description: "Allow SSH and all outbound from home",
  ingress: [
    {
      protocol: "tcp",
      fromPort: 22,
      toPort: 22,
      cidrBlocks: ["103.87.31.191/32"],
    },
    {
      protocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      cidrBlocks: ["103.87.31.191/32"],
    },
  ],
  egress: [
    { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
  ],
  tags: {
    Name: `${project}-${stack}-sg`,
    Project: `${project}`,
  },
});

// 6. ECS Cluster
const cluster = new aws.ecs.Cluster("ecsCluster", {
  name: `${project}-${stack}-ecs-cluster`,
});

// 7. IAM role and profile for ECS instance
const role = new aws.iam.Role("ecsRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "ec2.amazonaws.com",
  }),
  name: `${project}-${stack}-role`,
});

new aws.iam.RolePolicyAttachment("ecsRolAtch", {
  role: role.name,
  policyArn:
    "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
});

const instanceProfile = new aws.iam.InstanceProfile("ecsInsPro", {
  role: role.name,
  name: `${project}-${stack}-instance-profile`,
});

// 8. ECS-optimized Amazon Linux 2 AMI
const ami = aws.ec2.getAmi({
  mostRecent: true,
  owners: ["amazon"],
  filters: [{ name: "name", values: ["amzn2-ami-ecs-hvm-*-x86_64-ebs"] }],
});

// 9. Launch ECS instance
const ecsInstance = new aws.ec2.Instance("ecsNode", {
  ami: ami.then((a) => a.id),
  instanceType: "t3.small",
  subnetId: publicSubnets[0].id,
  vpcSecurityGroupIds: [sg.id],
  associatePublicIpAddress: true,
  iamInstanceProfile: instanceProfile.name,
  keyName: "ai",
  userData: pulumi.interpolate`#!/bin/bash
echo ECS_CLUSTER=${cluster.name} >> /etc/ecs/ecs.config`,
  tags: {
    Name: `${project}-${stack}-ecs-node`,
    Project: `${project}`,
  },
});

// Define IAM role for ECS task execution
const taskExecutionRole = new aws.iam.Role("tskExcRole", {
  name: `${project}-${stack}-task-execution-role`,
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: "sts:AssumeRole",
        Principal: {
          Service: "ecs-tasks.amazonaws.com",
        },
        Effect: "Allow",
        Sid: "",
      },
    ],
  }),
});

// Attach AWS managed policy for ECS execution
new aws.iam.RolePolicyAttachment("taskExecutionPolicyAttach", {
  role: taskExecutionRole.name,
  policyArn:
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

// IAM role assumed by ECS tasks
const taskRole = new aws.iam.Role("taskRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "ecs-tasks.amazonaws.com",
  }),
});

// Attach policy to allow reading SSM parameters
new aws.iam.RolePolicy("taskSsmReadPolicy", {
  name: `${project}-${stack}-task-ssm-read-policy`,
  role: taskRole.id,
  policy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "ssm:GetParameters",
          "ssm:GetParameter",
          "ssm:DescribeParameters",
        ],
        Resource: `arn:aws:ssm:${region}:865742897250:parameter/doublee/*`,
      },
    ],
  },
});

// Attach policy to allow reading SSM parameters
new aws.iam.RolePolicy("taskExecSsmReadPolicy", {
  name: `${project}-${stack}-task-execution-ssm-read-policy`,
  role: taskExecutionRole.id,
  policy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "ssm:GetParameters",
          "ssm:GetParameter",
          "ssm:DescribeParameters",
        ],
        Resource: `arn:aws:ssm:${region}:865742897250:parameter/doublee/*`,
      },
    ],
  },
});

// Attach AWS managed policy for ECS execution
new aws.iam.RolePolicyAttachment("taskRolePolicyAttach", {
  role: taskExecutionRole.name,
  policyArn:
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
});

// --- CloudWatch Logs group for ECS ---
const logGroup = new aws.cloudwatch.LogGroup("ecsDoubleeLogGroup", {
  name: "/ecs/doublee",
  retentionInDays: 7,
});

// Create the ECS Task Definition
const taskDefinition = new aws.ecs.TaskDefinition("myTaskDefinition", {
  family: "doublee",
  cpu: "256",
  memory: "512",
  networkMode: "bridge",
  requiresCompatibilities: ["EC2"],
  executionRoleArn: taskExecutionRole.arn,
  containerDefinitions: pulumi.interpolate`[
    {
      "name": "doublee-cnt",
      "image": "865742897250.dkr.ecr.${region}.amazonaws.com/doublee:0.02",
      "essential": true,
      "portMappings": [
        { "containerPort": 8080, "hostPort": 8080, "protocol": "tcp" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${logGroup.name}",
          "awslogs-region": "${region}",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]`,
});

// ECS Fargate Service
const service = new aws.ecs.Service(
  "app-service",
  {
    name: `${project}-${stack}-ecs-app`,
    cluster: cluster.arn,
    taskDefinition: taskDefinition.arn,
    desiredCount: 1,
    enableEcsManagedTags: true,
    launchType: "EC2",
    networkConfiguration: {
      subnets: [publicSubnets[0].id],
      assignPublicIp: false,
      securityGroups: [sg.id],
    },
  },
  { dependsOn: [taskDefinition] },
);


// Exports
export const awsRegion = region;
export const accountId = callerIdentity.then((identity) => identity.accountId);
export const clusterName = cluster.name;
export const instanceId = ecsInstance.id;
export const publicIp = ecsInstance.publicIp;
export const taskDefinitionArn = taskDefinition.arn;

// Triggering Build