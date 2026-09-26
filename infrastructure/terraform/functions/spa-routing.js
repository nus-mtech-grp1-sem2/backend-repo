// CloudFront Function (viewer request) on the S3 frontend behavior only.
// Angular routes such as /organiser/events/7 have no object in the bucket, so
// they are served index.html and the SPA router takes over. Paths with a file
// extension (main-XXXX.js, favicon.ico) are real assets and pass through.
// Doing this per behavior, instead of distribution-wide custom error pages,
// keeps /api/* 4xx responses (and their JSON error codes) intact.
function handler(event) {
  var request = event.request;
  var lastSegment = request.uri.split('/').pop();
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
