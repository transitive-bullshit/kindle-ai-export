import defaultKy, { type KyInstance } from 'ky'

import { assert, getEnv } from './utils'

export class UnrealSpeechClient {
  protected readonly ky: KyInstance

  constructor({
    apiKey = getEnv('UNREAL_SPEECH_API_KEY'),
    baseUrl = 'https://api.v6.unrealspeech.com',
    ky = defaultKy
  }: {
    apiKey?: string
    baseUrl?: string
    ky?: KyInstance
  } = {}) {
    assert(
      apiKey,
      'UnrealSpeechClient missing required "apiKey" (defaults to UNREAL_SPEECH_API_KEY)'
    )

    this.ky = ky.extend({
      prefixUrl: baseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })
  }

  async stream({
    text,
    voiceId = 'Scarlett',
    bitrate = '192k',
    speed = 0,
    pitch = 1.0,
    codec = 'libmp3lame',
    temperature = 0.25
  }: {
    text: string
    voiceId?: string
    bitrate?: string
    timestampType?: TimestampType
    speed?: number
    pitch?: number
    codec?: string
    temperature?: number
  }): Promise<ArrayBuffer> {
    const json: StreamPayload = {
      Text: text,
      VoiceId: voiceId,
      Bitrate: bitrate,
      Speed: speed,
      Pitch: pitch,
      Codec: codec,
      Temperature: temperature
    }

    return this.ky.post('stream', { json }).arrayBuffer()
  }

  async createSynthesisTask({
    text,
    voiceId = 'Scarlett',
    bitrate = '192k',
    timestampType = 'word',
    speed = 0,
    pitch = 1.0
  }: {
    text: string
    voiceId?: string
    bitrate?: string
    timestampType?: TimestampType
    speed?: number
    pitch?: number
  }): Promise<string | undefined> {
    const json: SynthesisTaskPayload = {
      Text: [text],
      VoiceId: voiceId,
      Bitrate: bitrate,
      TimestampType: timestampType,
      Speed: speed,
      Pitch: pitch
    }

    const data = await this.ky
      .post('synthesisTasks', { json })
      .json<SynthesisTaskResponse>()

    return data.SynthesisTask?.TaskId
  }

  async getSynthesisTaskStatus(
    taskId: string
  ): Promise<SynthesisTaskResponse['SynthesisTask']> {
    const maxAttempts = 10
    let attempts = 0

    do {
      const data = await this.ky
        .get(`synthesisTasks/${taskId}`)
        .json<SynthesisTaskResponse>()

      const taskStatus = data.SynthesisTask
      if (taskStatus?.TaskStatus === 'completed') {
        return taskStatus
      } else {
        console.log('Audio generation is in progress.')
        attempts++
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    } while (attempts < maxAttempts)

    throw new Error(`Task status check for ${taskId} exceeded maximum attempts`)
  }

  async speech({
    text,
    voiceId = 'Scarlett',
    bitrate = '192k',
    timestampType = 'sentence',
    speed = 0,
    pitch = 1.0
  }: {
    text: string
    voiceId?: string
    bitrate?: string
    timestampType?: TimestampType
    speed?: number
    pitch?: number
  }): Promise<SpeechResponse> {
    const json: SpeechPayload = {
      Text: text,
      VoiceId: voiceId,
      Bitrate: bitrate,
      OutputFormat: 'uri',
      TimestampType: timestampType,
      Speed: speed,
      Pitch: pitch
    }

    return this.ky.post('speech', { json }).json<SpeechResponse>()
  }
}

export type TimestampType = 'word' | 'sentence'

export interface SynthesisTaskResponse {
  SynthesisTask: {
    CreationTime: string
    OutputUri: string
    RequestCharacters: string
    TaskId: string
    TaskStatus: string
    VoiceId: string
  }
}

export interface UnrealSpeechOptions {
  text: string
  voiceId?: string
  bitrate?: string
  speed?: number
  pitch?: number
  codec?: string
  temperature?: number
  timestampType?: TimestampType
}

export interface StreamPayload {
  Text: string
  VoiceId: string
  Bitrate: string
  Speed: number
  Pitch: number
  Codec: string
  Temperature: number
}

export interface SynthesisTaskPayload {
  Text: string[]
  VoiceId: string
  Bitrate: string
  TimestampType: string
  Speed: number
  Pitch: number
}

export interface SpeechPayload {
  Text: string
  VoiceId: string
  Bitrate: string
  OutputFormat: string
  TimestampType: string
  Speed: number
  Pitch: number
}

export interface SpeechResponse {
  CreationTime: string
  OutputUri: string
  RequestCharacters: number
  TaskId: string
  TaskStatus: string
  TimestampsUri: string
  VoiceId: string
}
