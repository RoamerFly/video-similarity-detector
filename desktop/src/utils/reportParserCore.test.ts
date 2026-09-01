import { describe, expect, it } from 'vitest'
import { parseCsvReport, parseJsonValue } from './reportParserCore'

function pairReport(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-08-31T00:00:00Z',
    report_schema_version: 2,
    containment_scoring_version: 5,
    video_pairs: [
      {
        video_a: 'a.mp4',
        video_b: 'b.mp4',
        video_a_path: 'D:/videos/a.mp4',
        video_b_path: 'D:/videos/b.mp4',
        a_in_b: 0.76,
        b_in_a: 0.5,
        relation: 'partial_overlap',
        ...overrides,
      },
    ],
  }
}

describe('versioned report relation parsing', () => {
  it('preserves a modern partial-overlap label at 0.76/0.50', () => {
    const report = parseJsonValue(pairReport(), 'batch_report.json')

    expect(report.pairs[0].relation).toBe('partial_overlap')
  })

  it('preserves an explicit modern directional label', () => {
    const report = parseJsonValue(
      pairReport({
        relation: 'A_is_likely_clip_of_B',
        a_in_b: 0.9,
        b_in_a: 0.8,
        duration_a: 20,
        duration_b: 10,
      }),
      'batch_report.json',
    )

    expect(report.pairs[0].relation).toBe('A_is_likely_clip_of_B')
  })

  it('preserves backend labels from future report schema versions', () => {
    const report = parseJsonValue(
      pairReport({
        report_schema_version: 99,
        relation: 'future_relation',
        a_in_b: 0,
        b_in_a: 0,
      }),
      'batch_report.json',
    )

    expect(report.pairs[0].relation).toBe('future_relation')
  })

  it('keeps legacy relation derivation for reports without a schema version', () => {
    const legacy = pairReport({
      report_schema_version: undefined,
      containment_scoring_version: undefined,
      relation: 'A_is_likely_clip_of_B',
      a_in_b: 0.9,
      b_in_a: 0.8,
      duration_a: 20,
      duration_b: 10,
    })
    delete (legacy.video_pairs[0] as Record<string, unknown>).report_schema_version
    delete (legacy.video_pairs[0] as Record<string, unknown>).containment_scoring_version
    const legacyReport = { ...legacy }
    delete legacyReport.report_schema_version
    delete legacyReport.containment_scoring_version

    const report = parseJsonValue(legacyReport, 'legacy.json')

    expect(report.pairs[0].relation).toBe('B_is_likely_clip_of_A')
  })

  it('propagates top-level versions and lets pair versions take precedence', () => {
    const report = parseJsonValue(
      {
        ...pairReport(),
        video_pairs: [
          {
            ...pairReport().video_pairs[0],
            report_schema_version: 3,
            containment_scoring_version: 7,
          },
        ],
      },
      'batch_report.json',
    )

    expect(report.pairs[0].raw.report_schema_version).toBe(3)
    expect(report.pairs[0].raw.containment_scoring_version).toBe(7)
  })

  it('recognizes version fields in CSV pair rows', () => {
    const report = parseCsvReport(
      [
        'video_a,video_b,a_in_b,b_in_a,relation,report_schema_version,containment_scoring_version',
        'a.mp4,b.mp4,0.76,0.50,partial_overlap,2,5',
      ].join('\n'),
      'batch_report.csv',
    )

    expect(report.pairs[0].relation).toBe('partial_overlap')
    expect(report.pairs[0].raw.report_schema_version).toBe(2)
    expect(report.pairs[0].raw.containment_scoring_version).toBe(5)
  })

  it('derives a non-empty relation when a versioned row omits the backend label', () => {
    const report = parseJsonValue(
      pairReport({
        relation: '',
        a_in_b: 0,
        b_in_a: 0,
      }),
      'batch_report.json',
    )

    expect(report.pairs[0].relation).toBe('different')
  })

  it('uses unknown when both relation and metrics are missing', () => {
    const report = parseJsonValue(
      pairReport({
        relation: '',
        a_in_b: undefined,
        b_in_a: undefined,
      }),
      'batch_report.json',
    )

    expect(report.pairs[0].relation).toBe('unknown')
  })
})
