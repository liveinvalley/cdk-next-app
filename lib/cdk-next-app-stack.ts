import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as deployment from 'cdk-docker-image-deployment'
import * as path from 'path'

export class CdkNextAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ホスト名・ドメイン
    const domainName = 'example.com';
    const hostName = 'www';
    const fqdn = hostName + '.' + domainName;

    // ECRにプッシュするイメージにつけるタグ
    const tag = 'code-server-custom';

    // 既存のRoute53 HostedZoneをルックアップ
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: domainName,
    });

    // ACMで証明書を作成
    // Route53のHostedZoneを指定して自動取得
    const certificate = new cdk.aws_certificatemanager.Certificate(this, "Certificate", {
      domainName: fqdn,
      validation: cdk.aws_certificatemanager.CertificateValidation.fromDns(hostedZone),
    });

    // ECRリポジトリ作成
    // スタック削除時に自動削除
    const repository = new cdk.aws_ecr.Repository(this, 'Repository', {
      imageTagMutability: cdk.aws_ecr.TagMutability.MUTABLE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // webapp ディレクトリでイメージをビルドしてECRにデプロイ
    // カスタムタグを付与
    const imageDeployment = new deployment.DockerImageDeployment(this, 'DockerImageDeployment', {
      source: deployment.Source.directory(path.join('.', 'webapp')),
      destination: deployment.Destination.ecr(repository, {
        tag: tag,
      }),
    });

    // デプロイしたイメージをもとにLambda作成
    // イメージがプッシュされていないとエラーになるので，DockerImageDeploymentに依存させる
    const imageFunction = new lambda.DockerImageFunction(this, 'DockerImageFunction', {
      code: lambda.DockerImageCode.fromEcr(repository, {
        tagOrDigest: tag,
      }),
    });
    imageFunction.node.addDependency(imageDeployment);

    // API Gateway作成（Lambda統合プロキシ）
    // カスタムドメインとその証明書を付与
    const api = new apigateway.LambdaRestApi(this, 'LambdaRestApi', {
      handler: imageFunction,
      domainName: {
        certificate: certificate,
        domainName: fqdn,
      },
      binaryMediaTypes: [
        '*/*',
      ],
    });

    // Route53 にAレコード作成
    // 合わせて，HTTPSレコード作成（クライアントにHTTPアクセスを避けさせる; HTTP/2に対応していることを知らせる）
    const aRecord = new route53.ARecord(this, 'ARecord', {
      zone: hostedZone,
      recordName: hostName,
      target: route53.RecordTarget.fromAlias(new route53_targets.ApiGateway(api)),
    });
    const recordSet = new route53.RecordSet(this, 'RecordSet', {
      zone: hostedZone,
      recordName: hostName,
      recordType: route53.RecordType.HTTPS,
      target: {
        values: [
          '1 . alpn=h2',
        ],
      },
    });
  }
}
