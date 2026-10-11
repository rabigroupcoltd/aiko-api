import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  WEBSOCKET_CONTRACT,
  renderWebSocketReference,
} from './realtime/websocket-events';

const JSON_PATH = 'api/docs-json';
const YAML_PATH = 'api/docs-yaml';

const DOWNLOAD_LINKS_JS = `
(function () {
  var ATTEMPT_LIMIT = 100;
  var attempts = 0;

  var timer = setInterval(function () {
    if (++attempts > ATTEMPT_LIMIT) return clearInterval(timer);

    var host = document.querySelector('.information-container .info');
    if (!host || document.getElementById('spec-downloads')) return;
    clearInterval(timer);

    // /api/docs and /api/docs/ both reduce to /api/docs.
    var base = window.location.pathname.replace(/\\/+$/, '');

    var bar = document.createElement('div');
    bar.id = 'spec-downloads';

    [
      { label: 'Download OpenAPI JSON', href: base + '-json', file: 'openapi.json' },
      { label: 'Download YAML', href: base + '-yaml', file: 'openapi.yaml' },
    ].forEach(function (spec) {
      var link = document.createElement('a');
      link.href = spec.href;
      link.textContent = spec.label;
      link.setAttribute('download', spec.file);
      bar.appendChild(link);
    });

    var view = document.createElement('a');
    view.href = base + '-json';
    view.textContent = 'View raw';
    view.target = '_blank';
    view.rel = 'noopener';
    bar.appendChild(view);

    host.appendChild(bar);
  }, 100);
})();
`;

const DOWNLOAD_LINKS_CSS = `
#spec-downloads {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px 0 4px;
}
#spec-downloads a {
  display: inline-block;
  padding: 6px 14px;
  border: 1px solid #4990e2;
  border-radius: 4px;
  color: #4990e2;
  font-family: sans-serif;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
#spec-downloads a:hover {
  background: #4990e2;
  color: #fff;
}
`;

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Aiko API')
    .setDescription(
      [
        'Ride-hailing backend for tricycle and bicycle trips.',
        '',
        '### Response envelope',
        'Every endpoint answers with the same wrapper, and the HTTP status line',
        'always matches the `code` inside the body:',
        '',
        '```json',
        '{ "code": 200, "message": "SUCCESSFUL", "data": { } }',
        '```',
        '',
        'Failures swap `data` for `error`, which is a string or a list of',
        'validation messages:',
        '',
        '```json',
        '{ "code": 400, "message": "BAD REQUEST", "error": "amount must not be less than 1" }',
        '```',
        '',
        '### Authentication',
        'The app has one way in: `POST /api/auth/firebase`, which takes a Firebase',
        'ID token from either a Google sign-in or a verified phone OTP. There is no',
        'password and no separate registration call — the same request signs a new',
        'user up and signs a returning one back in.',
        '',
        '`POST /api/auth/login` is the staff door for the admin dashboard. App',
        'accounts hold no password and can never authenticate through it.',
        '',
        'Either way you get an `accessToken` valid for 7 days — hit **Authorize**',
        'and paste it — alongside an `onboarding` block telling you which screen',
        'the user belongs on.',
        '',
        '### Onboarding',
        'Send the user to `onboarding.resumeStep`. It is computed from what has',
        'actually been saved rather than from a stored counter, so it stays right',
        'even if the app was killed mid-step. `DONE` means go to the dashboard.',
        'Each screen reports back through `PATCH /api/onboarding`.',
        '',
        'Everyone walks `PHONE → PROFILE → PHOTO → LIVENESS → USER_TYPE`.',
        'Passengers finish there. Riders continue through `RIDER_DOCS` — the',
        'vehicle registration at `POST /api/drivers/register` — and then sit on',
        '`AWAITING_APPROVAL` until an admin clears their KYC.',
        '',
        'Every driver is a passenger by default, so gate app access on',
        '`onboarding.passengerReady` rather than `completed`. A rider waiting on',
        'approval can already book trips; `completed` stays false until the KYC',
        'is signed off.',
        '',
        '### Spec',
        `The raw document is at [/${JSON_PATH}](/${JSON_PATH}) and [/${YAML_PATH}](/${YAML_PATH})`,
        '— point Postman, Insomnia or a client generator straight at either.',
        '',
        renderWebSocketReference(),
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Paste the `accessToken` returned by login or register.',
      },
      'bearer',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  (document as unknown as Record<string, unknown>)['x-websocket'] = WEBSOCKET_CONTRACT;

  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: JSON_PATH,
    yamlDocumentUrl: YAML_PATH,
    customSiteTitle: 'Aiko API',
    customCss: DOWNLOAD_LINKS_CSS,
    customJsStr: DOWNLOAD_LINKS_JS,
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      filter: true,
      tagsSorter: 'alpha',
    },
  });
}
