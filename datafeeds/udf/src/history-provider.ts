import {
	Bar,
	HistoryMetadata,
	LibrarySymbolInfo,
	PeriodParams,
} from '../../../charting_library/datafeed-api';

import {
	getErrorMessage,
	RequestParams,
	UdfErrorResponse,
	UdfOkResponse,
	UdfResponse,
} from './helpers';

import { IRequester } from './irequester';

interface HistoryPartialDataResponse extends UdfOkResponse {
	t: any;
	c: any;
	o?: never;
	h?: never;
	l?: never;
	v?: never;
}

interface HistoryFullDataResponse extends UdfOkResponse {
	t: any;
	c: any;
	o: any;
	h: any;
	l: any;
	v: any;
}

interface HistoryNoDataResponse extends UdfResponse {
	s: 'no_data';
	nextTime?: number;
}

type HistoryResponse = HistoryFullDataResponse | HistoryPartialDataResponse | HistoryNoDataResponse;

export type PeriodParamsWithOptionalCountback = Omit<PeriodParams, 'countBack'> & { countBack?: number };

export interface GetBarsResult {
	bars: Bar[];
	meta: HistoryMetadata;
}

export interface LimitedResponseConfiguration {
	maxResponseLength: number;
	expectedOrder: 'latestFirst' | 'earliestFirst';
}

export class HistoryProvider {
	private _datafeedUrl: string;
	private readonly _requester: IRequester;
	private readonly _limitedServerResponse?: LimitedResponseConfiguration;

	public constructor(
		datafeedUrl: string,
		requester: IRequester,
		limitedServerResponse?: LimitedResponseConfiguration
	) {
		this._datafeedUrl = datafeedUrl;
		this._requester = requester;
		this._limitedServerResponse = limitedServerResponse;
	}

	public getBars(
		symbolInfo: LibrarySymbolInfo,
		resolution: string,
		periodParams: PeriodParamsWithOptionalCountback
	): Promise<GetBarsResult> {
		const requestParams: RequestParams = {
			symbol: symbolInfo.ticker || '',
			resolution: resolution,
			from: periodParams.from ?? 0,
			to: periodParams.to ?? Math.floor(Date.now() / 1000),
		};

		if (periodParams.countBack !== undefined) {
			requestParams.countback = periodParams.countBack;
		}

		if (symbolInfo.currency_code !== undefined) {
			requestParams.currencyCode = symbolInfo.currency_code;
		}

		if (symbolInfo.unit_id !== undefined) {
			requestParams.unitId = symbolInfo.unit_id;
		}

		return new Promise(async (resolve, reject) => {
			try {
				const initialResponse = await this._requester.sendRequest<HistoryResponse>(
					this._datafeedUrl,
					'history',
					requestParams
				);

				const result = this._processHistoryResponse(initialResponse);

				if (this._limitedServerResponse) {
					await this._processTruncatedResponse(result, requestParams);
				}

				resolve(result);
			} catch (e) {
				const reasonString = getErrorMessage(e);
				console.warn(`HistoryProvider: getBars() failed, error=${reasonString}`);
				reject(reasonString);
			}
		});
	}

	private async _processTruncatedResponse(result: GetBarsResult, requestParams: RequestParams) {
		let lastResultLength = result.bars.length;
		try {
			while (
				this._limitedServerResponse &&
				this._limitedServerResponse.maxResponseLength > 0 &&
				this._limitedServerResponse.maxResponseLength === lastResultLength &&
				(requestParams.from ?? 0) < (requestParams.to ?? 0)
			) {
				if (requestParams.countback) {
					requestParams.countback = (requestParams.countback as number) - lastResultLength;
				}

				if (this._limitedServerResponse.expectedOrder === 'earliestFirst') {
					requestParams.from = Math.round(result.bars[result.bars.length - 1].time / 1000);
				} else {
					requestParams.to = Math.round(result.bars[0].time / 1000);
				}

				const followupResponse = await this._requester.sendRequest<HistoryResponse>(
					this._datafeedUrl,
					'history',
					requestParams
				);
				const followupResult = this._processHistoryResponse(followupResponse);
				lastResultLength = followupResult.bars.length;

				if (this._limitedServerResponse.expectedOrder === 'earliestFirst') {
					if (followupResult.bars[0].time === result.bars[result.bars.length - 1].time) {
						followupResult.bars.shift();
					}
					result.bars.push(...followupResult.bars);
				} else {
					if (followupResult.bars[followupResult.bars.length - 1].time === result.bars[0].time) {
						followupResult.bars.pop();
					}
					result.bars.unshift(...followupResult.bars);
				}
			}
		} catch (e) {
			const reasonString = getErrorMessage(e);
			console.warn(`HistoryProvider: getBars() warning during followup request, error=${reasonString}`);
		}
	}

	private _processHistoryResponse(response: HistoryResponse | UdfErrorResponse): GetBarsResult {
		if (response.s !== 'ok' && response.s !== 'no_data') {
			throw new Error(response.errmsg);
		}

		const bars: Bar[] = [];
		const meta: HistoryMetadata = { noData: false };

		if (response.s === 'no_data') {
			meta.noData = true;
			meta.nextTime = response.nextTime;
		} else {
			const volumePresent = response.v !== undefined;
			const ohlPresent = response.o !== undefined;

			for (let i = 0; i < response.t.length; ++i) {
				const barValue: Bar = {
					time: response.t[i] * 1000,
					close: parseFloat(response.c[i]),
					open: parseFloat(response.c[i]),
					high: parseFloat(response.c[i]),
					low: parseFloat(response.c[i]),
				};

				if (ohlPresent) {
					barValue.open = parseFloat((response as HistoryFullDataResponse).o[i]);
					barValue.high = parseFloat((response as HistoryFullDataResponse).h[i]);
					barValue.low = parseFloat((response as HistoryFullDataResponse).l[i]);
				}

				if (volumePresent) {
					barValue.volume = parseFloat((response as HistoryFullDataResponse).v[i]);
				}

				bars.push(barValue);
			}
		}

		return {
			bars: bars,
			meta: meta,
		};
	}
}
