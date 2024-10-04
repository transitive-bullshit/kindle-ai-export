# kindle-api <!-- omit from toc -->

> API client for accessing Kindle's unofficial API.

<p>
  <a href="https://github.com/transitive-bullshit/kindle-api/actions/workflows/main.yml"><img alt="Build Status" src="https://github.com/transitive-bullshit/kindle-api/actions/workflows/main.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/kindle-api"><img alt="NPM" src="https://img.shields.io/npm/v/kindle-api.svg" /></a>
  <a href="https://github.com/transitive-bullshit/kindle-api/blob/main/license"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  <a href="https://prettier.io"><img alt="Prettier Code Formatting" src="https://img.shields.io/badge/code_style-prettier-brightgreen.svg" /></a>
</p>

- [Intro](#intro)
- [Install](#install)
- [Setup](#setup)
  - [Cookies](#cookies)
  - [Device Token](#device-token)
- [Disclaimer](#disclaimer)
- [License](#license)

## Intro

TODO

> [!IMPORTANT]
> This library is not officially supported by Amazon / Kindle. Using this library might violate Kindle's Terms of Service. Use it at your own risk.

## Install

```sh
npm install kindle-api
```

## Setup

This library does depends on an external [tls-client-api](https://github.com/bogdanfinn/tls-client-api) to proxy requests due to amazon's recent changes to their TLS fingerprinting. You'll need to run the server locally to be able to use this library. It's quite easy to set up and have one running in a few minutes and will save you tons of headache if you wanna do other kinds of scraping in the future.

### Cookies

Amazon's login system is quite strict and the SMS 2FA makes automating logins difficult. Instead of trying to automate that with puppeteer and slow things down, we use 4 cookies that stay valid for an entire year. (**TODO: one or more of these cookies is expiring every few minutes**)

- `ubid-main`
- `at-main`
- `x-main`
- `session-id`

You can grab these values directly by going on inspect element after loading [read.amazon.com](https://read.amazon.com) and copying the entire thing or just the select ones ![](./assets/cookie-demonstration.png)

### Device Token

We also need a deviceToken for your kindle. You can grab this from the same network window as before on the `getDeviceToken` request that looks like:

https://read.amazon.com/service/web/register/getDeviceToken?serialNumber=(your-device-token)&deviceType=(your-device-token)

![](./assets/kindle-device-token.png)

Both of those identifiers should be the same.

## Disclaimer

This library is not endorsed or supported by Kindle. It is an unofficial library intended for educational purposes and personal use only. By using this library, you agree to not hold the author or contributors responsible for any consequences resulting from its usage.

## License

MIT © [Travis Fischer](https://x.com/transitive_bs)

This package is an updated fork of https://github.com/Xetera/kindle-api
