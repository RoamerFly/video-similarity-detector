import { describe, expect, it } from 'vitest'

import { parseSubtitleCues } from './subtitleParser'

describe('subtitle parsing', () => {
  it('parses SRT blocks, strips markup, and ignores invalid ranges', () => {
    const content = [
      '\uFEFF1\r',
      '00:00:01,250 --> 00:00:03,500\r',
      '<i>Hello</i> &amp; world\r',
      '\r',
      '2\r',
      '00:00:04,000 --> 00:00:03,000\r',
      'invalid\r',
    ].join('\n')

    expect(parseSubtitleCues(content, 'srt')).toEqual([
      { start: 1.25, end: 3.5, text: 'Hello & world' },
    ])
  })

  it('parses WebVTT timestamps and cue settings', () => {
    const content = [
      'WEBVTT',
      '',
      'intro',
      '00:01.000 --> 00:03.250 align:start position:10%',
      'First line',
      'Second line',
    ].join('\n')

    expect(parseSubtitleCues(content, 'vtt')).toEqual([
      { start: 1, end: 3.25, text: 'First line\nSecond line' },
    ])
  })

  it('preserves commas in ASS dialogue and removes override tags', () => {
    const content = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:02.50,0:00:05.00,Default,,0,0,0,,{\\b1}你好，world,again\\N第二行',
    ].join('\n')

    expect(parseSubtitleCues(content, 'ass')).toEqual([
      { start: 2.5, end: 5, text: '你好，world,again\n第二行' },
    ])
  })
})
