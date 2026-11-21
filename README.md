# OnlyAVideo

The Hotfixed Version of the Original Onlyporn Addon authored by Mast3rCh1ef in his Original Repo:(https://github.com/Mast3rCh1ef/onlyporn)

This build contains four major websites as its provider for streams directly from their domains...which are...
Eporner, Porntrex, Spankbang, Xvideos, XNXX and Xhamster.

Supports Playback upto 4k depending on the video...

Has stable personal logging for the user and has no analytics to protect privacy...

Currently self-deployment ready...

## Testing

You need `yarn`  
[testing.md#testing-in-stremio-app](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/testing.md#testing-in-stremio-app)

https://github.com/Stremio/stremio-addon-sdk

## Local media proxy

The media proxy is served from the addon's HTTP server at `/hls-proxy`. It handles Javtiful HLS and MP4 streams, plus Javtiful and Javguru catalog posters, so proxied URLs remain reachable both locally and through the deployed addon host.
