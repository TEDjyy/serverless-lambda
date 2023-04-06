import {
  Context,
  CloudFrontResponseCallback,
  CloudFrontResponseResult
} from "aws-lambda";
import {CloudFrontResponseEvent} from "aws-lambda/trigger/cloudfront-response";

// Lambda@Edge header: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-restrictions.html
// Lambda@Edge Tutorial: https://github.com/bestdevhyo1225/realtime-image-resize
// Lambda@Edge: 3s, 1MB

/**
 * This is a Lambda@Edge function which processes images on the fly,
 * requested from Amazon CloudFront CDN. The code downloads the image from Amazon S3,
 * resizes it based on the requested type and size, and returns the image.
 * The supported image types are PNG, JPG, JPEG, GIF, WebP, and SVG. If an image type is not supported,
 * the response has a status of 403, with an error message. If a requested image doesn't exist, the response has a status of 404 with an error message.
 */

import AWS from 'aws-sdk';
import path from 'path';
import sizeOf from 'buffer-image-size';
import Sharp, {FormatEnum} from 'sharp';
import {CloudFrontHeaders} from "aws-lambda/common/cloudfront";

AWS.config.update({ useAccelerateEndpoint: true });

const S3 = new AWS.S3({ region: 'us-east-1' });
const BUCKET = {
  image: 'ogxyz-image',
  profile: 'ogxyz-image-profile'
};

/**
 * 서버리스 람다 핸들러 타입
 */
type ServerlessHandler = (
  event: CloudFrontResponseEvent,
  context: Context,
  callback: CloudFrontResponseCallback
) => void;

const imageType: { [key: string]: { x: null | number, y: null | number } } = {
  original: {
    x: null,
    y: null
  },
  profile: {
    x: 200,
    y: 200
  },
  thumbnail: {
    x: 300,
    y: 300
  },
  miniThumbnail: {
    x: 150,
    y: 150
  },
  resized: {
    x: 1440,
    y: 1440
  }
};

const validType: { [key: string]: string } = {
  'png': 'image/png',
  'jpg': 'image/jpg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg+xml': 'image/svg+xml',
  'svg': 'image/svg+xml'
};

const polyfillHost = 'https://d4gknzklml.execute-api.us-east-1.amazonaws.com';
// const polyfillHost = 'http://localhost:3000';

interface IResponse {
  status: string,
  statusDescription: string,
  headers: CloudFrontHeaders,
  bodyEncoding: 'text' | 'base64',
  body: string
}

export const handler: ServerlessHandler = (event, context, callback) => {
  const raw = event.Records[0].cf;
  const viewRequest = raw.request;
  const originResponse = raw.response;

  /** Default */
  const responseSuccessHeader = JSON.parse(JSON.stringify(originResponse));
  const responseFailHeader = JSON.parse(JSON.stringify(originResponse));
  responseSuccessHeader.status = '200';
  responseSuccessHeader.statusDescription = 'OK';
  responseSuccessHeader.headers['cache-control'] = [{ key: 'Cache-Control', value: 'max-age=31536000' }];
  responseSuccessHeader.headers['content-type'] = [{ key: 'Content-Type', value: '' }];
  responseFailHeader.status = '500';
  responseFailHeader.statusDescription = 'Failure';
  responseFailHeader.headers['cache-control'] = [{ key: 'Cache-Control', value: 'no-cache' }];
  responseFailHeader.headers['content-type'] = [{ key: 'Content-Type', value: 'application/json' }];
  const response: IResponse = {
    ...responseSuccessHeader,
    bodyEncoding: 'base64',
    body: '{}'
  };
  const failResponse: IResponse = {
    ...responseFailHeader,
    bodyEncoding: 'text',
    body: '{ "errorCode": 500, "errorMsg": "Invalid Error" }'
  };

  const URIPath = path.parse(decodeURIComponent(viewRequest.uri));
  /** [1]: image: string, [2]: imageType: string, [3]: imageKey */
  const pathParse = URIPath.dir.split('/');
  const ext = URIPath.ext.replace('.', '').toLowerCase();

  let bucketName: string;
  switch(pathParse[2]) {
    case 'profile': bucketName = BUCKET.profile; break;
    default: bucketName = BUCKET.image;
  }

  /** Timeout */
  const timer = setTimeout(() => {
    responseSuccessHeader.status = '302';
    responseSuccessHeader.statusDescription = 'Found';
    responseSuccessHeader.headers['location'] = [{ key: 'Location', value: `${polyfillHost}/prod/image/${pathParse[2]}/${decodeURI(URIPath.base)}` }];

    return callback(null,  {
      ...responseSuccessHeader
    });
  }, 5 * 1000);

  /** Start */
  try {
    // Origin Response Check & 404
    if(!originResponse || originResponse.status === '404') {
      failResponse.status = '404';
      failResponse.statusDescription = 'Not Found';
      failResponse.body = JSON.stringify({
        errorCode: '404',
        errorMsg: 'Not Found'
      });

      return callback(null, failResponse);
    }

    // Image Type
    if(!imageType[pathParse[2]]) {
      failResponse.status = '404';
      failResponse.statusDescription = 'Not Found';
      failResponse.body = JSON.stringify({
        errorCode: '404',
        errorMsg: 'Not Found'
      });

      return callback(null, failResponse);
    }

    // Valid Type
    if(!validType[ext]) {
      failResponse.status = '403';
      failResponse.statusDescription = 'Unsupported extension.';
      failResponse.body = JSON.stringify({
        errorCode: '403',
        errorMsg: 'Unsupported extension.'
      });

      return callback(null, failResponse);
    }

    try {
      S3.getObject({ Bucket: bucketName, Key: decodeURI(URIPath.base) }, (err: any, data: any) => {
        if(err && err.statusCode === 404) {
          failResponse.status = '404';
          failResponse.statusDescription = 'Not Found';
          failResponse.body = JSON.stringify({
            errorCode: '404',
            errorMsg: 'Not Found'
          });

          return callback(null, failResponse);
        }

        if(!data) {
          failResponse.status = '500';
          failResponse.statusDescription = '';
          failResponse.body = JSON.stringify({
            errorCode: '500',
            errorMsg: 'The file is not normal.'
          });

          return callback(null, failResponse);
        }

        if(data && !data.Body) {
          failResponse.status = '404';
          failResponse.statusDescription = 'Not Found';
          failResponse.body = JSON.stringify({
            errorCode: '404',
            errorMsg: 'Not Found'
          });

          return callback(null, failResponse);
        }

        switch(ext) {
          case 'svg': {
            response.body = data.Body.toString('base64');
            response.headers['content-type'] = [{ key: 'Content-Type', value: 'image/svg+xml' }];
            return callback(null, response);
          }

          default: {
            /**
             * size.x: number
             * size.y: number
             * size.type: string
             */
            const size = sizeOf(data.Body);

            /** No up-scale */
            if(size && size.type === 'webp' && (imageType[pathParse[2]].x! > size.width || imageType[pathParse[2]].y! > size.height)) {
              // 1MB Limit
              if(data.Body.length > (1024 * 1024)) {
                responseSuccessHeader.status = '302';
                responseSuccessHeader.statusDescription = 'Found';
                responseSuccessHeader.headers['location'] = [{ key: 'Location', value: `${polyfillHost}/prod/image/${pathParse[2]}/${decodeURI(URIPath.base)}` }];
                return callback(null,  {
                  ...responseSuccessHeader
                });
              }

              response.body = data.Body.toString('base64');
              response.headers['content-type'] = [{ key: 'Content-Type', value: 'image/webp' }];
              return callback(null, response);
            }

            // fit: https://sharp.pixelplumbing.com/api-resize
            Sharp(data.Body, { failOnError: false, animated: ['gif', 'webp'].includes(ext) })
              .withMetadata()
              .resize(imageType[pathParse[2]].x, imageType[pathParse[2]].y, { fit: 'inside' })
              // .toFormat(ext as keyof FormatEnum).toBuffer()
              .webp()
              .toBuffer()
              .then((resizedImage) => {
                response.body = resizedImage.toString('base64');

                // 1MB Limit
                if(response.body.length > (1024 * 1024)) {
                  responseSuccessHeader.status = '302';
                  responseSuccessHeader.statusDescription = 'Found';
                  responseSuccessHeader.headers['location'] = [{ key: 'Location', value: `${polyfillHost}/prod/image/${pathParse[2]}/${decodeURI(URIPath.base)}` }];
                  return callback(null,  {
                    ...responseSuccessHeader
                  });
                }

                // response.headers['content-type'] = [{ key: 'Content-Type', value: validType[ext] }];
                response.headers['content-type'] = [{ key: 'Content-Type', value: 'image/webp' }];
                return callback(null, response);
              })
              .catch((error) => {
                /** Resizing Error */
                return callback(error);
              });
          }
        }
      });
    } catch (error: any) {
      /** S3 Error */
      return callback(error);
    }
  } finally {
    clearTimeout(timer);
  }
};
