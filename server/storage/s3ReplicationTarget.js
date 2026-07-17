const fs = require('fs');
const {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

function createError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateS3Config(config = {}) {
  let endpoint;
  try {
    endpoint = new URL(String(config.endpoint || ''));
  } catch (_error) {
    throw createError('S3_ENDPOINT_INVALID');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw createError('S3_ENDPOINT_INVALID');
  }
  if (!String(config.bucket || '').trim()) throw createError('S3_BUCKET_REQUIRED');
  if (!String(config.region || '').trim()) throw createError('S3_REGION_REQUIRED');
  return config;
}

function createS3Client(options = {}) {
  const config = validateS3Config(options.config);
  if (!options.credentials) throw createError('S3_CREDENTIALS_REQUIRED');
  const credentials = {
    accessKeyId: options.credentials.accessKeyId,
    secretAccessKey: options.credentials.secretAccessKey,
  };
  if (options.credentials.sessionToken) credentials.sessionToken = options.credentials.sessionToken;
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle !== false,
    credentials,
    maxAttempts: Number(config.maxAttempts) || 3,
  });
}

function isNotFound(error) {
  return error?.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(error?.name);
}

class S3ReplicationTarget {
  constructor(options = {}) {
    this.config = validateS3Config(options.config);
    this.bucket = this.config.bucket;
    this.client = options.client || createS3Client({
      config: this.config,
      credentials: options.credentials,
    });
    this.uploadFactory = options.uploadFactory || ((uploadOptions) => new Upload(uploadOptions));
  }

  async headObject(objectKey) {
    const result = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    }));
    return {
      objectKey,
      size: Number(result.ContentLength) || 0,
      sha256: result.Metadata?.['myml-sha256'] || null,
      versionId: result.VersionId || null,
    };
  }

  async findObject(objectKey) {
    try {
      return await this.headObject(objectKey);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async putObject(operation, descriptor) {
    const body = operation.size === 0
      ? Buffer.alloc(0)
      : fs.createReadStream(null, {
          fd: descriptor.fd,
          autoClose: false,
          start: 0,
          end: operation.size - 1,
        });
    const upload = this.uploadFactory({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: operation.objectKey,
        Body: body,
        ContentLength: operation.size,
        ContentType: operation.contentType || 'application/octet-stream',
        Metadata: {
          'myml-sha256': operation.sha256,
          'myml-replication-operation': operation.id,
        },
      },
      queueSize: Number(this.config.multipartQueueSize) || 2,
      partSize: Number(this.config.multipartPartSizeBytes) || 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    const result = await upload.done();
    return {
      objectKey: operation.objectKey,
      size: operation.size,
      sha256: operation.sha256,
      versionId: result?.VersionId || null,
    };
  }

  async deleteObject(objectKey) {
    const result = await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    }));
    return { objectKey, deleted: true, versionId: result.VersionId || null };
  }

  destroy() {
    this.client.destroy?.();
  }
}

module.exports = {
  S3ReplicationTarget,
  createS3Client,
};
